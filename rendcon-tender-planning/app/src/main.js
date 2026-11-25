import './styles.css';
import { createDataLayer } from './data/index.js';
import { startApp } from './app.js';
import { showAuth, showNotMember } from './auth.js';

const dl = await createDataLayer();
dl.onAuthChange((ev) => {
  if (ev === 'PASSWORD_RECOVERY') showAuth(dl, 'recovery');
  else if (ev === 'SIGNED_OUT') location.reload();
});
const { signedIn } = await dl.init();
if (!signedIn) showAuth(dl, 'signin');
else {
  const ok = await startApp(dl);
  if (!ok) showNotMember(dl, (await dl.getSession())?.email || '');
}
