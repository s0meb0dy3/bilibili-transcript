async function setupSidebar() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'settings', title: '设置', contexts: ['action'] });
}

const setup = () => setupSidebar().catch(() => console.error('[B站逐字稿] 侧栏初始化失败，请重新加载扩展'));
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);
chrome.contextMenus.onClicked.addListener(info => {
  if (info.menuItemId === 'settings') chrome.runtime.openOptionsPage();
});
