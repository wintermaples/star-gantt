/**
 * The plugin id every module of `stargantt.view` attributes its faults to.
 *
 * A contributed callback's own owner is not observable through the public core API, so the
 * invoking plugin — this one — is what `core/pluginError` reports.
 */
export const PLUGIN_ID = "stargantt.view";
