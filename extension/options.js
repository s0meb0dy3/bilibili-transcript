import { readStored, writeStored } from './storage.js';

const checkbox = document.querySelector('#speaker-avatars');
const status = document.querySelector('#status');
checkbox.checked = (await readStored('speakerAvatars')) === true;
checkbox.addEventListener('change', async () => {
  await writeStored('speakerAvatars', checkbox.checked);
  status.textContent = '设置已保存';
});