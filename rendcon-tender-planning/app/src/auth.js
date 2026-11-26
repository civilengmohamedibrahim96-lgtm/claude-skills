// Sign-in / first password / reset / new password screen, shown over the app.
import { esc } from './lib/util.js';

const $ = (s) => document.querySelector(s);

function shell(title, body) {
  const logo = $('.appbar .logo');
  const el = $('#auth');
  el.innerHTML = `<div class="auth-card" role="dialog" aria-labelledby="authTitle">
    ${logo ? logo.outerHTML : ''}
    <h1 id="authTitle">${esc(title)}</h1>
    ${body}
  </div>`;
  el.hidden = false;
  return el;
}

const errLine = (el) => el.querySelector('.auth-err');
const setErr = (el, msg) => { const e = errLine(el); if (e) e.textContent = msg || ''; };

export function showAuth(dl, mode = 'signin') {
  if (mode === 'signup') return showSignUp(dl);
  if (mode === 'reset') return showReset(dl);
  if (mode === 'recovery') return showRecovery(dl);
  return showSignIn(dl);
}

function showSignIn(dl) {
  const el = shell('Redcon Tender Planning', `
    <p>Sign in with your email and password.</p>
    <form id="authForm" class="auth-form">
      <label>Email <input class="in" id="aEmail" type="email" autocomplete="username" required></label>
      <label>Password <input class="in" id="aPass" type="password" autocomplete="current-password" required></label>
      <div class="auth-err" role="alert"></div>
      <button class="btn primary" type="submit">Sign in</button>
    </form>
    <div class="auth-links">
      <button class="btn ghost sm" type="button" id="toSignup">New here? Create an account</button>
      <button class="btn ghost sm" type="button" id="toReset">Forgot password?</button>
    </div>`);
  el.querySelector('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = el.querySelector('button[type=submit]');
    btn.disabled = true;
    const res = await dl.signIn(el.querySelector('#aEmail').value.trim(), el.querySelector('#aPass').value);
    btn.disabled = false;
    if (!res.ok) setErr(el, res.error || 'Could not sign in');
    else location.reload();
  };
  el.querySelector('#toSignup').onclick = () => showSignUp(dl);
  el.querySelector('#toReset').onclick = () => showReset(dl);
  el.querySelector('#aEmail').focus();
}

function showSignUp(dl) {
  const el = shell('Create an account', `
    <p>Anyone can create an account. If you are not on the planning team yet, an admin lets you in before you can see the board.</p>
    <form id="authForm" class="auth-form">
      <label>Email <input class="in" id="aEmail" type="email" autocomplete="username" required></label>
      <label>Password <input class="in" id="aPass" type="password" autocomplete="new-password" minlength="8" required></label>
      <label>Repeat password <input class="in" id="aPass2" type="password" autocomplete="new-password" minlength="8" required></label>
      <div class="auth-err" role="alert"></div>
      <button class="btn primary" type="submit">Create account</button>
    </form>
    <div class="auth-links"><button class="btn ghost sm" type="button" id="toSignin">Back to sign in</button></div>`);
  el.querySelector('#toSignin').onclick = () => showSignIn(dl);
  el.querySelector('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const p1 = el.querySelector('#aPass').value, p2 = el.querySelector('#aPass2').value;
    if (p1 !== p2) return setErr(el, 'The two passwords do not match');
    const res = await dl.signUp(el.querySelector('#aEmail').value.trim(), p1);
    if (!res.ok) return setErr(el, res.error || 'Could not create the password');
    if (res.needsConfirmation) {
      el.querySelector('#authForm').innerHTML = '<p class="auth-ok">Check your email and click the link, then sign in.</p>';
      return;
    }
    location.reload();
  };
}

function showReset(dl) {
  const el = shell('Reset password', `
    <p>We will email you a link to choose a new password.</p>
    <form id="authForm" class="auth-form">
      <label>Email <input class="in" id="aEmail" type="email" autocomplete="username" required></label>
      <div class="auth-err" role="alert"></div>
      <button class="btn primary" type="submit">Send reset link</button>
    </form>
    <div class="auth-links"><button class="btn ghost sm" type="button" id="toSignin">Back to sign in</button></div>`);
  el.querySelector('#toSignin').onclick = () => showSignIn(dl);
  el.querySelector('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const res = await dl.requestPasswordReset(el.querySelector('#aEmail').value.trim());
    if (!res.ok) return setErr(el, res.error || 'Could not send the link');
    el.querySelector('#authForm').innerHTML = '<p class="auth-ok">If that email has an account, a reset link is on its way.</p>';
  };
}

function showRecovery(dl) {
  const el = shell('Choose a new password', `
    <form id="authForm" class="auth-form">
      <label>New password <input class="in" id="aPass" type="password" autocomplete="new-password" minlength="8" required></label>
      <label>Repeat password <input class="in" id="aPass2" type="password" autocomplete="new-password" minlength="8" required></label>
      <div class="auth-err" role="alert"></div>
      <button class="btn primary" type="submit">Save new password</button>
    </form>`);
  el.querySelector('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const p1 = el.querySelector('#aPass').value;
    if (p1 !== el.querySelector('#aPass2').value) return setErr(el, 'The two passwords do not match');
    const res = await dl.updatePassword(p1);
    if (!res.ok) return setErr(el, res.error || 'Could not save the password');
    location.reload();
  };
}

/** Signed in, but the email is not on the planning team. */
export function showNotMember(dl, email) {
  const el = shell('Waiting for access', `
    <p>Your account <b>${esc(email)}</b> is ready. An admin of the Redcon planning team still has to let you in. Try again once they have.</p>
    <div class="auth-links"><button class="btn sm" type="button" id="aOut">Sign out</button></div>`);
  el.querySelector('#aOut').onclick = async () => { await dl.signOut(); location.reload(); };
}
