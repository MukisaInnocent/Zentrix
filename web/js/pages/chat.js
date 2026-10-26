import { api, ApiError } from '../core/api.js';
import { $, h, setBusy } from '../core/dom.js';
import { askForm } from '../core/dialogs.js';
import { formatDate } from '../core/format.js';
import { toast } from '../core/toast.js';

// Member chat. "Invite chat" lists the person who invited you and the people you invited; "Chat with foreigners"
// pairs you with a random activated member from another country. Chat is free and shows usernames only. Messages
// arrive by polling while a chat is open.
const TABS = {
  invite: { title: 'Invite chat', lead: 'Chat with the person who invited you and the people you invited.', list: 'Invite conversations' },
  foreign: { title: 'Chat with foreigners', lead: 'Chat with members in other countries, found by random match.', list: 'Conversations with foreigners' },
};
const POLL_MS = 5000;

let tab = 'invite';
let open = null; // { id, username, blocked, lastId }

const errorText = err => (err instanceof ApiError ? err.message : 'Connection error. Please try again.');
const emptyRow = (cols, text) => h('tr', {}, h('td', { colspan: String(cols), class: 'zx-td-empty' }, text));

function chatButton(label, onClick) {
  const btn = h('button', { type: 'button', class: 'zx-btn zx-btn--secondary zx-btn--sm' }, label);
  btn.addEventListener('click', onClick);
  return btn;
}

async function loadContacts() {
  const { contacts } = await api.get('/api/chat/contacts');
  $('#contacts-body').replaceChildren(...(contacts.length
    ? contacts.map(c => h('tr', {},
      h('td', { class: 'zx-td-strong' }, `@${c.username}`),
      h('td', {}, c.relation === 'inviter' ? 'Invited you' : 'You invited'),
      h('td', {}, c.country),
      h('td', {}, c.blocked ? 'Blocked' : chatButton('Chat', async () => {
        try {
          const res = await api.post('/api/chat/conversations', { username: c.username });
          await openConversation(res.conversation.id);
        } catch (err) {
          toast.error(errorText(err));
        }
      }))))
    : [emptyRow(4, 'No contacts yet. People appear here once they have activated their account.')]));
}

async function loadConversations() {
  const { conversations } = await api.get('/api/chat/conversations');
  const list = conversations.filter(c => c.kind === tab);
  $('#conversations-body').replaceChildren(...(list.length
    ? list.map(c => h('tr', {},
      h('td', { class: 'zx-td-strong' }, `@${c.username}`),
      h('td', {}, c.country),
      h('td', { class: 'zx-td-muted' }, c.lastMessage ?? 'No messages yet'),
      h('td', {}, c.unread ? h('span', { class: 'zx-badge zx-badge--brand' }, String(c.unread)) : '0'),
      h('td', { class: 'zx-td-muted' }, c.lastMessageAt ? formatDate(c.lastMessageAt, { withTime: true }) : '-'),
      h('td', {}, chatButton('Open', () => void openConversation(c.id)))))
    : [emptyRow(6, tab === 'invite' ? 'No conversations yet. Start one from your contacts above.' : 'No conversations yet. Press the button above to meet someone.')]));
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

function messageEl(m) {
  return h('div', { class: `zx-msg${m.mine ? ' zx-msg--mine' : ''}` },
    h('span', { class: 'zx-msg__meta' }, `${m.mine ? 'You' : `@${m.username}`} · ${formatDate(m.createdAt, { withTime: true })}`), m.body);
}

function renderThreadHeader() {
  $('#thread-title').textContent = `@${open.username} (${open.country})`;
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
  const thread = $('#thread');
  if (open.lastId === 0 && !data.messages.length) thread.replaceChildren(h('p', { class: 'zx-hint' }, 'No messages yet. Say hello.'));
  if (data.messages.length) {
    if (open.lastId === 0) thread.replaceChildren();
    thread.append(...data.messages.map(messageEl));
    open.lastId = Number(data.messages.at(-1).id);
    thread.scrollTop = thread.scrollHeight;
  }
}

async function openConversation(id) {
  open = { id, username: '', country: '', blocked: false, lastId: 0 };
  $('#thread').replaceChildren(h('p', { class: 'zx-hint' }, 'Loading...'));
  $('#thread-card').hidden = false;
  try {
    await pullMessages();
    $('#thread-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    $('#thread-card').hidden = true;
  });

  await refreshAll().catch(err => toast.error(errorText(err)));
  setInterval(() => {
    if (document.visibilityState === 'visible') void Promise.all([loadConversations(), pullMessages()]).catch(() => undefined);
  }, POLL_MS);
}
