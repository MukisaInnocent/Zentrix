import { api, ApiError, newIdempotencyKey } from '../core/api.js';
import { $, h, setBusy } from '../core/dom.js';
import { askForm } from '../core/dialogs.js';
import { formatDate, formatMoney } from '../core/format.js';
import { toast } from '../core/toast.js';

// Member chat. "Invite chat" lists the person who invited you and the people you invited; "Chat with foreigners"
// pairs you with a random activated member from another country. Chat is free and shows usernames only. Messages
// arrive by polling while a chat is open. Messenger layout (owner, 2026-11-06): chat list, bubbles, composer bar.
const TABS = {
  invite: { title: 'Invite chat', lead: 'Chat with the person who invited you and the people you invited.', list: 'Chats' },
  foreign: { title: 'Chat with foreigners', lead: 'Chat with members in other countries, found by random match.', list: 'Chats with foreigners' },
};
const POLL_MS = 5000;

let tab = 'invite';
let open = null; // { id, username, blocked, lastId }

const errorText = err => (err instanceof ApiError ? err.message : 'Connection error. Please try again.');
const emptyRow = (cols, text) => h('tr', {}, h('td', { colspan: String(cols), class: 'zx-td-empty' }, text));
const emptyItem = text => h('li', { class: 'zx-wa__empty' }, text);
const avatar = username => h('span', { class: 'zx-wa__avatar', 'aria-hidden': 'true' }, (username || '?').slice(0, 1));

// Time for today, else the date, like a phone's chat list.
function shortWhen(value) {
  if (!value) return '';
  const d = new Date(value);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : formatDate(value);
}

function listItem({ username, last, when, unread, current, disabled, onClick }) {
  const btn = h('button', { type: 'button', class: 'zx-wa__item', 'aria-current': current ? 'true' : 'false' },
    avatar(username),
    h('span', { class: 'zx-wa__text' }, h('span', { class: 'zx-wa__name' }, username), h('span', { class: 'zx-wa__last' }, last)),
    h('span', { class: 'zx-wa__aside' }, when, unread ? h('span', { class: 'zx-wa__unread' }, String(unread)) : ''));
  if (disabled) btn.disabled = true;
  else btn.addEventListener('click', onClick);
  return h('li', {}, btn);
}

function chatButton(label, onClick) {
  const btn = h('button', { type: 'button', class: 'zx-btn zx-btn--secondary zx-btn--sm' }, label);
  btn.addEventListener('click', onClick);
  return btn;
}

async function loadContacts() {
  const { contacts } = await api.get('/api/chat/contacts');
  $('#contacts-list').replaceChildren(...(contacts.length
    ? contacts.map(c => listItem({
      username: c.username,
      last: `${c.relation === 'inviter' ? 'Invited you' : 'You invited'} · ${c.country}`,
      when: c.blocked ? 'Blocked' : '',
      disabled: c.blocked,
      onClick: async () => {
        try {
          const res = await api.post('/api/chat/conversations', { username: c.username });
          await openConversation(res.conversation.id);
        } catch (err) {
          toast.error(errorText(err));
        }
      },
    }))
    : [emptyItem('No contacts yet. People appear here once they have activated their account.')]));
}

async function loadConversations() {
  const { conversations } = await api.get('/api/chat/conversations');
  const list = conversations.filter(c => c.kind === tab);
  $('#conversations-list').replaceChildren(...(list.length
    ? list.map(c => listItem({
      username: c.username,
      last: c.lastMessage ?? `${c.country} · No messages yet`,
      when: shortWhen(c.lastMessageAt),
      unread: open?.id === c.id ? 0 : c.unread,
      current: open?.id === c.id,
      onClick: () => void openConversation(c.id),
    }))
    : [emptyItem(tab === 'invite' ? 'No chats yet. Start one from your contacts below.' : 'No chats yet. Press the button above to meet someone.')]));
}

async function loadBlocked() {
  const { blocked } = await api.get('/api/chat/blocks');
  $('#blocked-body').replaceChildren(...(blocked.length
    ? blocked.map(b => h('tr', {},
      h('td', { class: 'zx-td-strong' }, `@${b.username}`),
      h('td', { class: 'zx-td-muted' }, formatDate(b.blockedAt)),
      h('td', {}, chatButton('Unblock', async () => {
        try {
          await api.delete(`/api/chat/blocks/${encodeURIComponent(b.username)}`);
          toast.success(`@${b.username} is unblocked.`);
          await refreshAll();
        } catch (err) {
          toast.error(errorText(err));
        }
      }))))
    : [emptyRow(3, 'You have not blocked anyone.')]));
}

// A day label before the first message of each day, then the bubble with its time inside.
function messageEls(m) {
  const day = new Date(m.createdAt).toDateString();
  const out = [];
  if (day !== open.lastDay) {
    open.lastDay = day;
    out.push(h('div', { class: 'zx-wa__day' }, day === new Date().toDateString() ? 'Today' : formatDate(m.createdAt)));
  }
  const time = new Date(m.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  out.push(h('div', { class: `zx-bubble${m.mine ? ' zx-bubble--mine' : ''}` }, m.body, h('span', { class: 'zx-bubble__time' }, time)));
  return out;
}

// Chat with foreigners reward (owner, 2026-11-06): the server says the amount and whether it can be claimed.
function renderReward(reward) {
  const bar = $('#reward-bar');
  bar.hidden = !reward;
  if (!reward) return;
  const amount = formatMoney(reward.amountMinor, reward.currency);
  $('#reward-text').textContent = reward.claimed ? `Reward claimed: ${amount}` : reward.claimable ? `Chat reward: ${amount}` : `Chat reward ${amount}. ${reward.needs ?? ''}`;
  $('#claim-btn').hidden = reward.claimed;
  $('#claim-btn').disabled = !reward.claimable;
}

function renderThreadHeader() {
  $('#thread-title').textContent = open.username;
  $('#thread-sub').textContent = open.country;
  $('#thread-avatar').textContent = (open.username || '?').slice(0, 1);
  $('#block-btn').textContent = open.blocked ? 'Blocked' : 'Block';
  $('#block-btn').disabled = open.blocked;
  $('#send-btn').disabled = open.blocked;
  $('#message-alert').textContent = open.blocked ? 'One of you has blocked the other, so messages cannot be sent.' : '';
}

// Fetches new messages for the open chat (all of them the first time) and marks them read. Calls share one
// request at a time, so a poll and a send never append the same message twice.
let pulling = null;
function pullMessages() {
  pulling ??= fetchNewMessages().finally(() => {
    pulling = null;
  });
  return pulling;
}

async function fetchNewMessages() {
  if (!open) return;
  const current = open;
  const data = await api.get(`/api/chat/conversations/${current.id}?after=${current.lastId}`);
  if (open !== current) return; // the member opened another chat meanwhile
  Object.assign(open, { username: data.conversation.username, country: data.conversation.country, blocked: data.conversation.blocked });
  renderThreadHeader();
  renderReward(data.reward);
  const thread = $('#thread');
  if (open.lastId === 0 && !data.messages.length) thread.replaceChildren(h('p', { class: 'zx-wa__hint' }, 'No messages yet. Say hello.'));
  if (data.messages.length) {
    if (open.lastId === 0) thread.replaceChildren();
    thread.append(...data.messages.flatMap(messageEls));
    open.lastId = Number(data.messages.at(-1).id);
    thread.scrollTop = thread.scrollHeight;
  }
}

async function openConversation(id) {
  open = { id, username: '', country: '', blocked: false, lastId: 0, lastDay: '' };
  $('#thread').replaceChildren(h('p', { class: 'zx-wa__hint' }, 'Loading...'));
  $('#thread-placeholder').hidden = true;
  $('#thread-view').hidden = false;
  $('#messenger').classList.add('zx-wa--open');
  try {
    await pullMessages();
    $('#message-body').focus();
    await loadConversations();
  } catch (err) {
    toast.error(errorText(err));
  }
}

async function refreshAll() {
  await Promise.all([tab === 'invite' ? loadContacts() : null, loadConversations(), loadBlocked(), open ? pullMessages() : null]);
}

export async function init() {
  const wanted = new URLSearchParams(location.search).get('tab');
  tab = TABS[wanted] ? wanted : 'invite';
  if (wanted !== tab) history.replaceState(null, '', `${location.pathname}?tab=${tab}`);
  $('#chat-title').textContent = TABS[tab].title;
  $('#chat-lead').textContent = TABS[tab].lead;
  $('#conversations-title').textContent = TABS[tab].list;
  $('#contacts-card').hidden = tab !== 'invite';
  $('#match-card').hidden = tab !== 'foreign';
  // Live chat sits under Chat with foreigners (owner, 2026-11-06).
  $('#live-chat').hidden = tab !== 'foreign';

  $('#match-btn').addEventListener('click', async e => {
    const btn = e.currentTarget;
    $('#match-alert').textContent = '';
    setBusy(btn, true);
    try {
      const res = await api.post('/api/chat/match', {});
      toast.success(`You are matched with @${res.conversation.username} (${res.conversation.country}).`);
      await openConversation(res.conversation.id);
    } catch (err) {
      $('#match-alert').textContent = errorText(err);
    } finally {
      setBusy(btn, false);
    }
  });

  $('#message-form').addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('#message-body');
    const body = input.value.trim();
    if (!open || !body) return input.focus();
    $('#message-alert').textContent = '';
    setBusy($('#send-btn'), true);
    try {
      await api.post(`/api/chat/conversations/${open.id}/messages`, { body });
      input.value = '';
      await pullMessages();
    } catch (err) {
      $('#message-alert').textContent = errorText(err);
    } finally {
      setBusy($('#send-btn'), false);
      renderThreadHeader();
    }
  });
  $('#message-body').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#message-form').requestSubmit();
    }
  });

  $('#claim-btn').addEventListener('click', async e => {
    if (!open) return;
    const btn = e.currentTarget;
    setBusy(btn, true);
    try {
      const res = await api.post(`/api/chat/conversations/${open.id}/claim`, {}, { idempotencyKey: newIdempotencyKey() });
      toast.success(`${formatMoney(res.reward.amountMinor, res.reward.currency)} added to your chat rewards.`);
      renderReward(res.reward);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(btn, false);
    }
  });

  $('#block-btn').addEventListener('click', async () => {
    if (!open) return;
    const { username } = open;
    const done = await askForm({
      title: `Block @${username}?`, text: 'Neither of you will be able to send messages, and you will not be matched again. You can unblock later.',
      submitLabel: 'Block', tone: 'danger',
      submit: () => api.post('/api/chat/blocks', { username }),
    });
    if (!done) return;
    toast.success(`@${username} is blocked.`);
    await refreshAll().catch(() => undefined);
  });

  $('#report-btn').addEventListener('click', async () => {
    if (!open) return;
    const conversationId = open.id;
    const sent = await askForm({
      title: 'Report this chat', text: 'Our team will read this conversation and act on it. The other member is not told who reported them.',
      submitLabel: 'Send report', tone: 'danger',
      fields: [{ name: 'reason', label: 'What is wrong?', type: 'textarea', required: true, minLength: 5 }],
      submit: v => api.post(`/api/chat/conversations/${conversationId}/report`, { reason: v.reason }),
    });
    if (sent) toast.success('Report sent. Thank you.');
  });

  $('#close-btn').addEventListener('click', () => {
    open = null;
    $('#thread-view').hidden = true;
    $('#thread-placeholder').hidden = false;
    $('#messenger').classList.remove('zx-wa--open');
    void loadConversations().catch(() => undefined);
  });

  await refreshAll().catch(err => toast.error(errorText(err)));
  setInterval(() => {
    if (document.visibilityState === 'visible') void Promise.all([loadConversations(), pullMessages()]).catch(() => undefined);
  }, POLL_MS);
}
