const FORMAT_VERSION = 1;

export function exportProps(propStore) {
  const data = propStore.exportData();
  return JSON.stringify({ version: FORMAT_VERSION, ...data }, null, 2);
}

export function downloadProps(propStore, filename = "scene.v3props") {
  const json = exportProps(propStore);
  const blob = new Blob([json], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function importPropsFromFile(file, propStore, typeNameToIdx) {
  const text = await file.text();
  const data = JSON.parse(text);
  if (data.version !== FORMAT_VERSION) {
    console.warn("[propsIO] Unknown format version:", data.version);
  }
  propStore.importData(data, typeNameToIdx);
}
