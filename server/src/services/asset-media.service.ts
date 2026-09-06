import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import sanitize from 'sanitize-filename';
import { StorageCore } from 'src/cores/storage.core';
import { Asset, AuthSharedLink } from 'src/database';
import {
  AssetBulkUploadCheckResponseDto,
  AssetMediaResponseDto,
  AssetMediaStatus,
  AssetRejectReason,
  AssetUploadAction,
} from 'src/dtos/asset-media-response.dto';
import {
  AssetBulkUploadCheckDto,
  AssetMediaCreateDto,
  AssetMediaOptionsDto,
  AssetMediaSize,
  UploadFieldName,
} from 'src/dtos/asset-media.dto';
import {
  AssetUploadChunkResponseDto,
  AssetUploadCompleteDto,
  AssetUploadInitDto,
  AssetUploadInitResponseDto,
  AssetUploadStatusResponseDto,
  DEFAULT_UPLOAD_CHUNK_SIZE_BYTES,
  UploadStatus,
} from 'src/dtos/asset-upload.dto';
import { AssetDownloadOriginalDto } from 'src/dtos/asset.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  AssetFileType,
  AssetVisibility,
  CacheControl,
  ChecksumAlgorithm,
  JobName,
  Permission,
  StorageFolder,
} from 'src/enum';
import { AuthRequest } from 'src/middleware/auth.guard';
import { BaseService } from 'src/services/base.service';
import { UploadFile, UploadRequest } from 'src/types';
import { requireUploadAccess } from 'src/utils/access';
import { asUploadRequest, onBeforeLink } from 'src/utils/asset.util';
import { isAssetChecksumConstraint } from 'src/utils/database';
import { getFilenameExtension, getFileNameWithoutExtension, ImmichFileResponse } from 'src/utils/file';
import { mimeTypes } from 'src/utils/mime-types';
import { fromChecksum } from 'src/utils/request';

export interface AssetMediaRedirectResponse {
  targetSize: AssetMediaSize | 'original';
}

export interface UploadSession {
  /** Unique identifier for the upload session (the UUID used for the temp file) */
  uploadId: string;
  userId: string;
  /** Original filename provided by the client */
  filename: string;
  fileSize: number;
  checksum: Buffer;
  chunkSize: number;
  /** Total number of bytes received so far */
  received: number;
  status: UploadStatus;
  /** Path to the part file being assembled on disk (also the final resting location) */
  path: string;
  createdAt: Date;
  metadata?: AssetUploadInitDto['metadata'];
  isFavorite?: boolean;
  visibility?: AssetVisibility;
  livePhotoVideoId?: string;
  fileCreatedAt?: Date;
  fileModifiedAt?: Date;
  duration?: number;
}

@Injectable()
export class AssetMediaService extends BaseService {
  async getUploadAssetIdByChecksum(auth: AuthDto, checksum?: string): Promise<AssetMediaResponseDto | undefined> {
    if (!checksum) {
      return;
    }

    const assetId = await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, fromChecksum(checksum));
    if (!assetId) {
      return;
    }

    return { id: assetId, status: AssetMediaStatus.DUPLICATE };
  }

  canUploadFile({ auth, fieldName, file, body }: UploadRequest): true {
    requireUploadAccess(auth);

    const filename = body.filename || file.originalName;

    switch (fieldName) {
      case UploadFieldName.ASSET_DATA: {
        if (mimeTypes.isAsset(filename)) {
          return true;
        }
        break;
      }

      case UploadFieldName.SIDECAR_DATA: {
        if (mimeTypes.isSidecar(filename)) {
          return true;
        }
        break;
      }

      case UploadFieldName.PROFILE_DATA: {
        if (mimeTypes.isProfile(filename)) {
          return true;
        }
        break;
      }
    }

    this.logger.error(`Unsupported file type ${filename}`);
    throw new BadRequestException(`Unsupported file type ${filename}`);
  }

  getUploadFilename({ auth, fieldName, file, body }: UploadRequest): string {
    requireUploadAccess(auth);

    const extension = getFilenameExtension(body.filename || file.originalName);
    const lookup = {
      [UploadFieldName.ASSET_DATA]: extension,
      [UploadFieldName.SIDECAR_DATA]: '.xmp',
      [UploadFieldName.PROFILE_DATA]: extension,
    };

    return sanitize(`${file.uuid}${lookup[fieldName]}`);
  }

  getUploadFolder({ auth, fieldName, file }: UploadRequest): string {
    auth = requireUploadAccess(auth);

    let folder = StorageCore.getNestedFolder(StorageFolder.Upload, auth.user.id, file.uuid);
    if (fieldName === UploadFieldName.PROFILE_DATA) {
      folder = StorageCore.getFolderLocation(StorageFolder.Profile, auth.user.id);
    }

    this.storageRepository.mkdirSync(folder);

    return folder;
  }

  async onUploadError(request: AuthRequest, file: Express.Multer.File) {
    const uploadFilename = this.getUploadFilename(asUploadRequest(request, file));
    const uploadFolder = this.getUploadFolder(asUploadRequest(request, file));
    const uploadPath = `${uploadFolder}/${uploadFilename}`;

    await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [uploadPath] } });
  }

  /**
   * In-memory store for active chunked upload sessions. Sessions are scoped to a single
   * user and are cleaned up on completion/failure/cancellation. Because the server is a
   * single stateless API process (with the important caveat that this state does not
   * survive restarts or multiple replicas), chunked uploads are best completed promptly.
   */
  private readonly uploadSessions = new Map<string, UploadSession>();

  private getUploadSession(auth: AuthDto, uploadId: string): UploadSession {
    const session = this.uploadSessions.get(uploadId);
    if (!session || session.userId !== auth.user.id) {
      throw new NotFoundException('Upload session not found');
    }
    return session;
  }

  private deleteUploadSession(uploadId: string): void {
    this.uploadSessions.delete(uploadId);
  }

  async initUpload(auth: AuthDto, dto: AssetUploadInitDto): Promise<AssetUploadInitResponseDto> {
    auth = requireUploadAccess(auth);

    // Reject non-asset file types early (mirrors the single-request path).
    if (!mimeTypes.isAsset(dto.filename)) {
      throw new BadRequestException(`Unsupported file type ${dto.filename}`);
    }

    // Duplicate detection before any bytes are transferred.
    const existing = await this.getUploadAssetIdByChecksum(auth, dto.checksum);
    if (existing) {
      return {
        uploadId: randomUUID(),
        chunkSize: dto.chunkSize ?? DEFAULT_UPLOAD_CHUNK_SIZE_BYTES,
        status: UploadStatus.COMPLETED,
        duplicate: true,
        assetId: existing.id,
      };
    }

    const uploadId = randomUUID();
    const chunkSize = Math.min(dto.chunkSize ?? DEFAULT_UPLOAD_CHUNK_SIZE_BYTES, DEFAULT_UPLOAD_CHUNK_SIZE_BYTES);

    // Use the same nested upload folder scheme as the single-request path.
    const folder = StorageCore.getNestedFolder(StorageFolder.Upload, auth.user.id, uploadId);
    this.storageRepository.mkdirSync(folder);

    const extension = getFilenameExtension(dto.filename);
    const filename = sanitize(`${uploadId}${extension}`);
    const tempPath = join(folder, filename);

    const session: UploadSession = {
      uploadId,
      userId: auth.user.id,
      filename: dto.filename,
      fileSize: dto.fileSize,
      checksum: fromChecksum(dto.checksum),
      chunkSize,
      received: 0,
      status: UploadStatus.INITIALIZED,
      path: tempPath,
      createdAt: new Date(),
      metadata: dto.metadata,
      isFavorite: dto.isFavorite,
      visibility: dto.visibility,
      livePhotoVideoId: dto.livePhotoVideoId,
      fileCreatedAt: dto.fileCreatedAt,
      fileModifiedAt: dto.fileModifiedAt,
      duration: dto.duration,
    };

    this.uploadSessions.set(uploadId, session);

    return {
      uploadId,
      chunkSize,
      status: UploadStatus.INITIALIZED,
    };
  }

  async uploadChunk(
    auth: AuthDto,
    uploadId: string,
    chunkIndex: number,
    file: UploadFile,
  ): Promise<AssetUploadChunkResponseDto> {
    auth = requireUploadAccess(auth);
    const session = this.getUploadSession(auth, uploadId);
    if (session.status === UploadStatus.COMPLETED || session.status === UploadStatus.FAILED) {
      throw new BadRequestException(`Upload session is already ${session.status}`);
    }

    try {
      // Append the received chunk (already streamed to disk by the interceptor) to the session file.
      const source = await this.storageRepository.createReadStream(file.originalPath);
      const target = this.storageRepository.createAppendStream(session.path);
      await pipelineStream(source.stream, target);

      session.received += file.size;
      session.status = session.received >= session.fileSize ? UploadStatus.COMPLETED : UploadStatus.IN_PROGRESS;

      // Clean up the chunk temp file.
      await this.storageRepository.unlink(file.originalPath).catch(() => {});

      return {
        uploadId,
        chunkIndex,
        received: session.received,
        status: session.status,
      };
    } catch (error) {
      await this.destroySession(session);
      throw error;
    }
  }

  getUploadStatus(auth: AuthDto, uploadId: string): Promise<AssetUploadStatusResponseDto> {
    auth = requireUploadAccess(auth);
    const session = this.getUploadSession(auth, uploadId);
    return Promise.resolve({ uploadId, received: session.received, status: session.status });
  }

  async cancelUpload(auth: AuthDto, uploadId: string): Promise<void> {
    auth = requireUploadAccess(auth);
    const session = this.getUploadSession(auth, uploadId);
    await this.destroySession(session);
  }

  async completeUpload(auth: AuthDto, uploadId: string, dto: AssetUploadCompleteDto): Promise<AssetMediaResponseDto> {
    auth = requireUploadAccess(auth);
    const session = this.getUploadSession(auth, uploadId);

    if (session.status !== UploadStatus.COMPLETED) {
      throw new BadRequestException('Upload is not complete');
    }

    // Verify the assembled file matches the declared size.
    try {
      const stat = await this.storageRepository.stat(session.path);
      if (stat.size !== session.fileSize) {
        throw new BadRequestException(`Upload size mismatch: expected ${session.fileSize}, received ${stat.size}`);
      }
    } catch (error: Error | any) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Upload file not found');
    }

    // Compute the checksum of the assembled file and compare with the declared checksum.
    const checksum = await this.hashFile(session.path);
    if (!checksum.equals(session.checksum)) {
      await this.destroySession(session);
      throw new BadRequestException('Upload checksum mismatch');
    }

    const file: UploadFile = {
      uuid: session.uploadId,
      checksum,
      originalPath: session.path,
      originalName: session.filename,
      size: session.fileSize,
    };

    const assetDto: AssetMediaCreateDto = {
      fileCreatedAt: dto.fileCreatedAt ?? session.fileCreatedAt ?? new Date(),
      fileModifiedAt: dto.fileModifiedAt ?? session.fileModifiedAt ?? new Date(),
      isFavorite: dto.isFavorite ?? session.isFavorite,
      visibility: dto.visibility ?? session.visibility,
      livePhotoVideoId: dto.livePhotoVideoId ?? session.livePhotoVideoId,
      duration: dto.duration ?? session.duration,
      metadata: dto.metadata ?? session.metadata,
    };

    try {
      const response = await this.uploadAsset(auth, assetDto, file);
      this.deleteUploadSession(uploadId);
      return response;
    } catch (error) {
      await this.destroySession(session);
      throw error;
    }
  }

  private async destroySession(session: UploadSession): Promise<void> {
    this.deleteUploadSession(session.uploadId);
    await this.storageRepository.unlink(session.path).catch(() => {});
  }

  private async hashFile(filepath: string): Promise<Buffer> {
    const hash = createHash('sha1');
    const source = await this.storageRepository.createReadStream(filepath);
    await pipelineStream(source.stream, hash);
    return hash.digest();
  }

  async uploadAsset(
    auth: AuthDto,
    dto: AssetMediaCreateDto,
    file: UploadFile,
    sidecarFile?: UploadFile,
  ): Promise<AssetMediaResponseDto> {
    let asset: Asset | undefined;
    try {
      await this.requireAccess({
        auth,
        permission: Permission.AssetUpload,
        // do not need an id here, but the interface requires it
        ids: [auth.user.id],
      });

      this.requireQuota(auth, file.size);

      if (dto.livePhotoVideoId) {
        await onBeforeLink(
          { asset: this.assetRepository, event: this.eventRepository },
          { userId: auth.user.id, livePhotoVideoId: dto.livePhotoVideoId },
        );
      }

      asset = await this.assetRepository.create({
        ownerId: auth.user.id,
        libraryId: null,

        checksum: file.checksum,
        checksumAlgorithm: ChecksumAlgorithm.sha1File,
        originalPath: file.originalPath,

        fileCreatedAt: dto.fileCreatedAt,
        fileModifiedAt: dto.fileModifiedAt,
        localDateTime: dto.fileCreatedAt,

        type: mimeTypes.assetType(file.originalPath),
        isFavorite: dto.isFavorite,
        duration: dto.duration || null,
        visibility: dto.visibility ?? AssetVisibility.Timeline,
        livePhotoVideoId: dto.livePhotoVideoId,
        originalFileName: dto.filename || file.originalName,
      });

      if (dto.metadata?.length) {
        await this.assetRepository.upsertMetadata(asset.id, dto.metadata);
      }

      if (sidecarFile) {
        await this.assetRepository.upsertFile({
          assetId: asset.id,
          path: sidecarFile.originalPath,
          type: AssetFileType.Sidecar,
        });
        await this.storageRepository.utimes(sidecarFile.originalPath, new Date(), new Date(dto.fileModifiedAt));
      }
      await this.storageRepository.utimes(file.originalPath, new Date(), new Date(dto.fileModifiedAt));
      await this.assetRepository.upsertExif({
        exif: { assetId: asset.id, fileSizeInByte: file.size },
        lockedPropertiesBehavior: 'override',
      });

      await this.jobRepository.queue({ name: JobName.AssetExtractMetadata, data: { id: asset.id, source: 'upload' } });

      if (auth.sharedLink) {
        await this.addToSharedLink(auth.sharedLink, asset.id);
      }

      await this.eventRepository.emit('AssetCreate', { asset, file });

      return { id: asset.id, status: AssetMediaStatus.CREATED };
    } catch (error: any) {
      // clean up files
      await this.jobRepository.queue({
        name: JobName.FileDelete,
        data: { files: [file.originalPath, sidecarFile?.originalPath] },
      });

      // handle duplicates with a success response
      if (isAssetChecksumConstraint(error)) {
        const duplicateId = await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, file.checksum);
        if (!duplicateId) {
          this.logger.error(`Error locating duplicate for checksum constraint`);
          throw new InternalServerErrorException();
        }

        if (auth.sharedLink) {
          await this.addToSharedLink(auth.sharedLink, duplicateId);
        }

        this.logger.debug(`Duplicate asset upload rejected: existing asset ${duplicateId}`);
        return { status: AssetMediaStatus.DUPLICATE, id: duplicateId };
      }

      // clean up the asset row if one was created
      if (asset) {
        await this.assetRepository.remove({ id: asset.id });
      }

      this.logger.error(`Error uploading file ${error}`, error?.stack);
      throw error;
    }
  }

  async downloadOriginal(auth: AuthDto, id: string, dto: AssetDownloadOriginalDto): Promise<ImmichFileResponse> {
    await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: [id] });

    if (auth.sharedLink) {
      dto.edited = true;
    }

    const { originalPath, originalFileName, editedPath } = await this.assetRepository.getForOriginal(
      id,
      dto.edited ?? false,
    );

    const path = editedPath ?? originalPath!;

    return new ImmichFileResponse({
      path,
      fileName: getFileNameWithoutExtension(originalFileName) + getFilenameExtension(path),
      contentType: mimeTypes.lookup(path),
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  async viewThumbnail(
    auth: AuthDto,
    id: string,
    dto: AssetMediaOptionsDto,
  ): Promise<ImmichFileResponse | AssetMediaRedirectResponse> {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [id] });

    if (dto.size === AssetMediaSize.Original) {
      throw new BadRequestException('May not request original file');
    }

    if (auth.sharedLink) {
      dto.edited = true;
    }

    const size = (dto.size ?? AssetMediaSize.THUMBNAIL) as unknown as AssetFileType;
    const { originalPath, originalFileName, path } = await this.assetRepository.getForThumbnail(
      id,
      size,
      dto.edited ?? false,
    );

    if (size === AssetFileType.FullSize && mimeTypes.isWebSupportedImage(originalPath) && !dto.edited) {
      // use original file for web supported images
      return { targetSize: 'original' };
    }

    if (dto.size === AssetMediaSize.FULLSIZE && !path) {
      // downgrade to preview if fullsize is not available.
      // e.g. disabled or not yet (re)generated
      return { targetSize: AssetMediaSize.PREVIEW };
    }

    if (!path) {
      throw new NotFoundException('Asset media not found');
    }

    const fileNameBase =
      auth.sharedLink && !auth.sharedLink.showExif ? id : getFileNameWithoutExtension(originalFileName);
    const fileName = `${fileNameBase}_${size}${getFilenameExtension(path)}`;

    return new ImmichFileResponse({
      fileName,
      path,
      contentType: mimeTypes.lookup(path),
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  async playbackVideo(auth: AuthDto, id: string): Promise<ImmichFileResponse> {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [id] });

    const asset = await this.assetRepository.getForVideo(id);

    if (!asset) {
      throw new NotFoundException('Asset not found or asset is not a video');
    }

    const filepath = asset.encodedVideoPath || asset.originalPath;

    return new ImmichFileResponse({
      path: filepath,
      contentType: mimeTypes.lookup(filepath),
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  async bulkUploadCheck(auth: AuthDto, dto: AssetBulkUploadCheckDto): Promise<AssetBulkUploadCheckResponseDto> {
    const checksums: Buffer[] = dto.assets.map((asset) => fromChecksum(asset.checksum));
    const results = await this.assetRepository.getByChecksums(auth.user.id, checksums);
    const checksumMap: Record<string, { id: string; isTrashed: boolean }> = {};

    for (const { id, deletedAt, checksum } of results) {
      checksumMap[checksum.toString('hex')] = { id, isTrashed: !!deletedAt };
    }

    return {
      results: dto.assets.map(({ id, checksum }) => {
        const duplicate = checksumMap[fromChecksum(checksum).toString('hex')];
        if (duplicate) {
          return {
            id,
            action: AssetUploadAction.REJECT,
            reason: AssetRejectReason.DUPLICATE,
            assetId: duplicate.id,
            isTrashed: duplicate.isTrashed,
          };
        }

        return {
          id,
          action: AssetUploadAction.ACCEPT,
        };
      }),
    };
  }

  private async addToSharedLink(sharedLink: AuthSharedLink, assetId: string) {
    if (!sharedLink.albumId) {
      await this.sharedLinkRepository.addAssets(sharedLink.id, [assetId]);
      return;
    }

    const album = await this.albumRepository.getById(sharedLink.albumId, { withAssets: false });
    if (!album) {
      return;
    }

    await this.albumRepository.addAssetIds(album.id, [assetId]);
    const userIds = album.albumUsers.map(({ user }) => user.id);
    await this.eventRepository.emit('AlbumUpdate', {
      id: album.id,
      userIds,
      recipientIds: userIds,
    });
  }

  private requireQuota(auth: AuthDto, size: number) {
    if (auth.user.quotaSizeInBytes !== null && auth.user.quotaSizeInBytes < auth.user.quotaUsageInBytes + size) {
      throw new BadRequestException('Quota has been exceeded!');
    }
  }
}

const pipelineStream = async (source: NodeJS.ReadableStream, target: NodeJS.WritableStream): Promise<void> => {
  await pipeline(source as any, target as any);
};
