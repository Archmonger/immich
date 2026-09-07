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
          bind:value={configToEdit.upload.chunkedUpload.maxChunkSize}
          required={true}
          disabled={disabled || !configToEdit.upload.chunkedUpload.enabled}
          isEdited={configToEdit.upload.chunkedUpload.maxChunkSize !== config.upload.chunkedUpload.maxChunkSize}
        />

        <SettingButtonsRow bind:configToEdit keys={['upload']} {disabled} />
      </div>
    </form>
  </div>
</div>
