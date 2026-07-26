import path from "node:path";

const PASSTHROUGH_KEYS = Object.freeze([
  "APPDATA",
  "CARGO_HOME",
  "CC",
  "CI",
  "COMSPEC",
  "CXX",
  "DBUS_SESSION_BUS_ADDRESS",
  "DEVELOPER_DIR",
  "DISPLAY",
  "GDK_BACKEND",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "MACOSX_DEPLOYMENT_TARGET",
  "PATH",
  "PATHEXT",
  "PKG_CONFIG_PATH",
  "RUSTUP_HOME",
  "SDKROOT",
  "SYSTEMROOT",
  "TERM",
  "TMP",
  "TMPDIR",
  "TEMP",
  "USERPROFILE",
  "WAYLAND_DISPLAY",
  "WINDIR",
  "XDG_RUNTIME_DIR",
]);

export function createDesktopShellEnvironment({
  environment = process.env,
  isolationRoot,
  additions = {},
} = {}) {
  const output = {};
  for (const key of PASSTHROUGH_KEYS) {
    if (environment[key] !== undefined) output[key] = environment[key];
  }
  if (isolationRoot !== undefined) {
    output.HOME = isolationRoot;
    output.USERPROFILE = isolationRoot;
    output.APPDATA = path.join(isolationRoot, "app-data");
    output.LOCALAPPDATA = path.join(isolationRoot, "local-data");
    output.TMP = path.join(isolationRoot, "tmp");
    output.TEMP = path.join(isolationRoot, "tmp");
    output.TMPDIR = path.join(isolationRoot, "tmp");
    output.XDG_CACHE_HOME = path.join(isolationRoot, "cache");
    output.XDG_CONFIG_HOME = path.join(isolationRoot, "config");
    output.XDG_DATA_HOME = path.join(isolationRoot, "data");
  }
  for (const [key, value] of Object.entries(additions)) {
    if (value !== undefined) output[key] = String(value);
  }
  return Object.freeze(output);
}
