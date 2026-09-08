<script lang="ts">
  import SettingButtonsRow from '$lib/components/shared-components/settings/SystemConfigButtonRow.svelte';
  import SettingInputField from '$lib/components/shared-components/settings/SettingInputField.svelte';
  import SettingSwitch from '$lib/components/shared-components/settings/SettingSwitch.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const config = $derived(systemConfigManager.value);
  let configToEdit = $state(systemConfigManager.cloneValue());

  const MEGABYTE = 1024 * 1024;
  const bytesToMb = (bytes: number) => Math.round((bytes / MEGABYTE) * 100) / 100;
  const mbToBytes = (mb: number) => Math.round(mb * MEGABYTE);

  // The setting is configured in megabytes (float) but stored in bytes. The
  // accessor keeps the input field and the underlying config value in sync.
  const maxChunkSizeMb = $state<{ value: number; lastBytes: number }>({
    value: bytesToMb(configToEdit.upload.chunkedUpload.maxChunkSize),
    lastBytes: configToEdit.upload.chunkedUpload.maxChunkSize,
  });

  // When the underlying bytes change (e.g. reset-to-default), refresh the MB field.
  $effect(() => {
    const bytes = configToEdit.upload.chunkedUpload.maxChunkSize;
    if (bytes !== maxChunkSizeMb.lastBytes) {
      maxChunkSizeMb.value = bytesToMb(bytes);
      maxChunkSizeMb.lastBytes = bytes;
    }
  });

  // Keep the underlying config value in sync with the user-entered MB value.
  $effect(() => {
    configToEdit.upload.chunkedUpload.maxChunkSize = mbToBytes(maxChunkSizeMb.value);
    maxChunkSizeMb.lastBytes = configToEdit.upload.chunkedUpload.maxChunkSize;
  });
</script>

<div>
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" onsubmit={(event) => event.preventDefault()}>
      <div class="ms-4 mt-4 flex flex-col gap-4">
        <SettingSwitch
          title={$t('admin.upload_chunked_enabled_description')}
          {disabled}
          bind:checked={configToEdit.upload.chunkedUpload.enabled}
        />

        <hr />

        <SettingInputField
          inputType={SettingInputFieldType.NUMBER}
          label={$t('admin.upload_max_chunk_size')}
          description={$t('admin.upload_max_chunk_size_description')}
          bind:value={maxChunkSizeMb.value}
          min={1}
          max={100}
          step="0.01"
          required={true}
          disabled={disabled || !configToEdit.upload.chunkedUpload.enabled}
          isEdited={configToEdit.upload.chunkedUpload.maxChunkSize !== config.upload.chunkedUpload.maxChunkSize}
        />

        <SettingButtonsRow bind:configToEdit keys={['upload']} {disabled} />
      </div>
    </form>
  </div>
</div>
