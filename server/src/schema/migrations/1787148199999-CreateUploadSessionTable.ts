import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "upload_session" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "userId" uuid NOT NULL,
  "filename" character varying NOT NULL,
  "fileSize" bigint NOT NULL,
  "checksum" bytea NOT NULL,
  "chunkSize" bigint NOT NULL,
  "received" bigint NOT NULL DEFAULT 0,
  "status" character varying NOT NULL,
  "path" character varying NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '[]',
  "isFavorite" boolean,
  "visibility" character varying,
  "livePhotoVideoId" uuid,
  "fileCreatedAt" timestamp with time zone,
  "fileModifiedAt" timestamp with time zone,
  "duration" integer,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "upload_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "upload_session_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "upload_session_userId_idx" ON "upload_session" ("userId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "upload_session";`.execute(db);
}
