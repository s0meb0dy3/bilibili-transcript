// 扩展本地存储，沿用既有键以保留历史稿件。
export async function readStored(key) {
  const values = await chrome.storage.local.get(key);
  return values[key];
}

export async function writeStored(key, value) {
  await chrome.storage.local.set({ [key]: value });
}
