/* ══════════════════════════════════════════
   ENGINE REGISTRY — 14-Engine Super AI
   Ordered strictly by intelligence hierarchy
   (must match api/server.js keys)
══════════════════════════════════════════ */
const ENGINES = [
  // ── Tier 1: Advanced Reasoning & JEE Specialists ──────────────────
  { key:'gemini',      name:'Gemini',      sub:'Google · gemini-2.5-flash',             color:'#4285F4' },
  { key:'openrouter',  name:'OpenRouter',  sub:'Claude / GPT free router',              color:'#8b5cf6' },
  { key:'deepseek',    name:'DeepSeek',    sub:'DeepSeek-V3 · Math & Reasoning',        color:'#00b4d8' },
  // ── Tier 2: High-Performance Brains ───────────────────────────────
  { key:'mistral',     name:'Mistral',     sub:'mistral-small · Text + Vision',         color:'#f97316' },
  { key:'nvidia',      name:'NVIDIA',      sub:'NIM · Llama 3.1 70B Enterprise',        color:'#76b900' },
  { key:'zai',         name:'Zai AI',      sub:'GLM-4.5-Flash · Advanced Multilingual', color:'#e91e8c' },
  // ── Tier 3: Global Cloud & Model Hubs ─────────────────────────────
  { key:'cloudflare',  name:'Cloudflare',  sub:'Workers AI · Llama 3.3 70B Fast',       color:'#f6821f' },
  { key:'siliconflow', name:'SiliconFlow', sub:'Qwen2.5-7B · Open-Source Hub',          color:'#06b6d4' },
  { key:'huggingface', name:'HuggingFace', sub:'Llama 3.1 8B Instruct',                 color:'#ffcc4d' },
  { key:'fireworks',   name:'Fireworks',   sub:'Llama 3.1 8B · Developer Hub',          color:'#ff5e5e' },
  { key:'cohere',      name:'Cohere',      sub:'command-r-08-2024 · Enterprise Text',   color:'#39594D' },
  // ── Tier 4: Ultra-Fast Real-Time Engines ──────────────────────────
  { key:'groq',        name:'Groq',        sub:'gpt-oss-20b · Ultra-Fast Inference',    color:'#FF8C00' },
  { key:'sambanova',   name:'SambaNova',   sub:'Llama 3.3 70B · Fast Inference',        color:'#cc2936' },
  { key:'cerebras',    name:'Cerebras',    sub:'Llama 3.3 70B · Fast Inference',        color:'#9b59b6' },
];

/* Tier groups — used by renderEngineMenu() to draw
   optgroup-style separators in the custom dropdown. */
const ENGINE_GROUPS = [
  {
    label: '👑 Tier 1: Advanced Reasoning & JEE Specialists',
    keys: ['gemini', 'openrouter', 'deepseek'],
  },
  {
    label: '⚡ Tier 2: High-Performance Brains',
    keys: ['mistral', 'nvidia', 'zai'],
  },
  {
    label: '🌐 Tier 3: Global Cloud & Model Hubs',
    keys: ['cloudflare', 'siliconflow', 'huggingface', 'fireworks', 'cohere'],
  },
  {
    label: '🚀 Tier 4: Ultra-Fast Real-Time Engines',
    keys: ['groq', 'sambanova', 'cerebras'],
  },
];

const engineByKey = k => ENGINES.find(e => e.key === k) || ENGINES[0];

let selectedEngine = localStorage.getItem('bn_engine') || 'groq';
let currentUser = null;
let chats = [];
let activeChatId = null;
let pendingAttachment = null; // { base64, mimeType, name, isImage, dataUrl } — current unsent attachment

/* ══════════════════════════════════════════
   SIDEBAR
══════════════════════════════════════════ */
function toggleSidebar(){
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('overlay').classList.toggle('on');
}
function closeSidebar(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('on');
}

/* ══════════════════════════════════════════
   MODEL SELECTOR (dropup pill)
══════════════════════════════════════════ */
function renderEngineMenu(){
  const menu = document.getElementById('engineMenu');
  // Build grouped HTML: each tier gets a label header followed by its engine options
  let html = '';
  for (const group of ENGINE_GROUPS) {
    html += `<div class="engine-group-label">${group.label}</div>`;
    for (const key of group.keys) {
      const e = ENGINES.find(eng => eng.key === key);
      if (!e) continue;
      html += `
        <div class="engine-opt ${e.key===selectedEngine?'active':''}" onclick="pickEngine('${e.key}')">
          <span class="model-dot" style="background:${e.color}"></span>
          <div>
            <div class="eo-name">${e.name}</div>
            <div class="eo-sub">${e.sub}</div>
          </div>
        </div>`;
    }
  }
  menu.innerHTML = html;
}
function toggleEngineMenu(){
  renderEngineMenu();
  document.getElementById('engineMenu').classList.toggle('open');
}
function pickEngine(key){
  selectedEngine = key;
  localStorage.setItem('bn_engine', key);
  updatePillUI();
  document.getElementById('engineMenu').classList.remove('open');
}
function updatePillUI(){
  const e = engineByKey(selectedEngine);
  document.getElementById('pillName').textContent = e.name;
  document.getElementById('pillDot').style.background = e.color;
}
document.addEventListener('click', (ev) => {
  const menu = document.getElementById('engineMenu');
  const pill = document.getElementById('modelPill');
  if (menu.classList.contains('open') && !menu.contains(ev.target) && !pill.contains(ev.target)) {
    menu.classList.remove('open');
  }
});

/* ══════════════════════════════════════════
   PLUS BUTTON → FLOATING ATTACH MENU
══════════════════════════════════════════ */
function toggleAttachMenu(ev){
  if (ev) ev.stopPropagation();
  const menu = document.getElementById('attachMenu');
  const btn = document.getElementById('plusBtn');
  const willOpen = !menu.classList.contains('open');
  menu.classList.toggle('open', willOpen);
  btn.classList.toggle('active', willOpen);
}
document.addEventListener('click', (ev) => {
  const menu = document.getElementById('attachMenu');
  const wrap = document.getElementById('plusWrap');
  if (menu.classList.contains('open') && !wrap.contains(ev.target)) {
    menu.classList.remove('open');
    document.getElementById('plusBtn').classList.remove('active');
  }
});
function triggerPicker(kind){
  document.getElementById('attachMenu').classList.remove('open');
  document.getElementById('plusBtn').classList.remove('active');
  if (kind === 'photo') document.getElementById('fileInputPhoto').click();
  else if (kind === 'camera') document.getElementById('fileInputCamera').click();
  else document.getElementById('fileInputFile').click();
}

/* ══════════════════════════════════════════
   FILE / IMAGE → BASE64 PROCESSING
   Images are downscaled + re-encoded as JPEG on a
   canvas before becoming base64, so uploads stay
   small and fast even from a 12MP phone camera.
   Generic files are read as-is (size-capped).
══════════════════════════════════════════ */
const MAX_RAW_FILE_BYTES = 6 * 1024 * 1024;      // pre-read cap for non-image files
const MAX_ATTACHMENT_BASE64_CHARS = 8000000;      // ~6MB raw after base64 inflation

function fileToBase64(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}
function compressImageToBase64(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX_EDGE = 1280;
        let { width, height } = img;
        if (width > MAX_EDGE || height > MAX_EDGE) {
          if (width >= height) { height = Math.round(height * (MAX_EDGE / width)); width = MAX_EDGE; }
          else { width = Math.round(width * (MAX_EDGE / height)); height = MAX_EDGE; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const mimeType = 'image/jpeg';
        const dataUrl = canvas.toDataURL(mimeType, 0.78);
        resolve({ base64: dataUrl.split(',')[1] || '', mimeType, dataUrl });
      };
      img.onerror = () => reject(new Error('Could not decode that image.'));
      img.src = String(reader.result);
    };
    reader.onerror = () => reject(new Error('Could not read the image.'));
    reader.readAsDataURL(file);
  });
}
async function handleFileSelect(ev){
  const input = ev.target;
  const file = input.files && input.files[0];
  input.value = ''; // reset so the same file can be re-picked later
  if (!file) return;

  const isImage = file.type.startsWith('image/');
  try {
    if (isImage) {
      const { base64, mimeType, dataUrl } = await compressImageToBase64(file);
      setPendingAttachment({ base64, mimeType, dataUrl, name: file.name, isImage: true });
    } else {
      if (file.size > MAX_RAW_FILE_BYTES) {
        showToast('That file is too large (max ~6MB). Please choose a smaller file.');
        return;
      }
      const base64 = await fileToBase64(file);
      if (base64.length > MAX_ATTACHMENT_BASE64_CHARS) {
        showToast('That file is too large (max ~6MB). Please choose a smaller file.');
        return;
      }
      setPendingAttachment({ base64, mimeType: file.type || 'application/octet-stream', name: file.name, isImage: false });
    }
  } catch (err) {
    showToast(err?.message || 'Could not process that file.');
  }
}
function setPendingAttachment(att){
  pendingAttachment = att;
  renderAttachPreview();
}
function clearAttachment(){
  pendingAttachment = null;
  renderAttachPreview();
}
function renderAttachPreview(){
  const wrap = document.getElementById('attachPreviewWrap');
  const box = document.getElementById('attachPreview');
  if (!pendingAttachment) { wrap.style.display = 'none'; box.innerHTML = ''; return; }
  wrap.style.display = 'block';
  box.innerHTML = pendingAttachment.isImage
    ? `<div class="attach-item">
         <img class="attach-thumb" src="${pendingAttachment.dataUrl}" alt="Attached image preview"/>
         <button class="attach-remove" onclick="clearAttachment()" aria-label="Remove attachment">✕</button>
       </div>`
    : `<div class="attach-item">
         <div class="attach-file-chip">
           <span class="afc-ico">📄</span>
           <span class="afc-name">${escapeHtml(pendingAttachment.name || 'file')}</span>
         </div>
         <button class="attach-remove" onclick="clearAttachment()" aria-label="Remove attachment">✕</button>
       </div>`;
}

/* ══════════════════════════════════════════
   TOASTS
══════════════════════════════════════════ */
function showToast(msg, ms=5000){
  const wrap = document.getElementById('toastWrap');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity='0'; el.style.transition='opacity .3s'; setTimeout(()=>el.remove(),300); }, ms);
}

/* ══════════════════════════════════════════
   UTILITY: HTML ESCAPE (used for user bubbles
   and any raw text inserted into HTML)
══════════════════════════════════════════ */
function escapeHtml(s){
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ══════════════════════════════════════════
   RICH CONTENT RENDERER — Marked.js + KaTeX
   ─────────────────────────────────────────
   The trick: LaTeX math MUST be extracted and
   replaced with opaque placeholders BEFORE
   marked.parse() runs, because Marked will
   escape $ signs and mangle \[ \] sequences.
   After Markdown is rendered we put the KaTeX
   HTML back in place of every placeholder.

   Supported delimiters:
     Block:  $$ ... $$   and   \[ ... \]
     Inline: $ ... $     and   \( ... \)
══════════════════════════════════════════ */
function renderContent(raw) {
  if (!raw) return '';

  // Stash for extracted math expressions
  const mathStore = [];

  function protect(type, math) {
    const id = mathStore.length;
    mathStore.push({ type, math });
    // Null-byte delimiters — invisible to Marked and safe in HTML
    return `\x00MATH${id}\x00`;
  }

  let s = raw;

  // 1. Block math: $$...$$ — must match before single $
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => protect('block', m));

  // 2. Block math: \[...\]
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => protect('block', m));

  // 3. Inline math: \(...\)
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => protect('inline', m));

  // 4. Inline math: $...$ (no newlines — avoids false positives on lone $ in prices)
  s = s.replace(/\$([^\$\n]+?)\$/g, (_, m) => protect('inline', m));

  // 5. Run full Markdown rendering
  s = marked.parse(s);

  // 6. Restore each placeholder as a rendered KaTeX equation
  s = s.replace(/\x00MATH(\d+)\x00/g, (_, idx) => {
    const { type, math } = mathStore[parseInt(idx, 10)];
    try {
      return katex.renderToString(math.trim(), {
        displayMode: type === 'block',
        throwOnError: false,
        output: 'html',
      });
    } catch (e) {
      // Fallback: show the raw LaTeX in a code tag so it's still readable
      return `<code class="math-err">${escapeHtml(math)}</code>`;
    }
  });

  return s;
}

/* ══════════════════════════════════════════
   CHAT STORAGE (per Firebase user, localStorage)
══════════════════════════════════════════ */
function storageKey(){ return `bn_chats_${currentUser ? currentUser.uid : 'anon'}`; }
function loadChats(){
  try { chats = JSON.parse(localStorage.getItem(storageKey())) || []; } catch { chats = []; }
}
function saveChats(){
  localStorage.setItem(storageKey(), JSON.stringify(chats));
}
function getActiveChat(){
  return chats.find(c => c.id === activeChatId) || null;
}
function newChat(){
  const chat = { id: 'c_' + Date.now(), title: 'New chat', messages: [], createdAt: Date.now() };
  chats.unshift(chat);
  activeChatId = chat.id;
  saveChats();
  renderHistory();
  renderMessages();
  closeSidebar();
  document.getElementById('msgInput').focus();
}
function switchChat(id){
  activeChatId = id;
  renderHistory();
  renderMessages();
  closeSidebar();
}
function deleteChat(id, ev){
  ev.stopPropagation();
  chats = chats.filter(c => c.id !== id);
  saveChats();
  if (activeChatId === id) {
    activeChatId = chats.length ? chats[0].id : null;
    if (!activeChatId) newChat();
  }
  renderHistory();
  renderMessages();
}
function renderHistory(){
  const list = document.getElementById('histList');
  if (!chats.length) { list.innerHTML = '<div style="color:var(--faint);font-size:.78rem;padding:8px 10px;">No chats yet</div>'; return; }
  list.innerHTML = chats.map(c => `
    <div class="hist-item ${c.id===activeChatId?'active':''}" onclick="switchChat('${c.id}')">
      <span class="hist-title">${escapeHtml(c.title || 'New chat')}</span>
      <button class="hist-del" onclick="deleteChat('${c.id}', event)">✕</button>
    </div>
  `).join('');
}

/* ══════════════════════════════════════════
   MESSAGE RENDERING
══════════════════════════════════════════ */
function renderMessages(){
  const inner = document.getElementById('chatInner');
  const chat = getActiveChat();
  if (!chat || !chat.messages.length) {
    inner.innerHTML = `
      <div class="empty-state">
        <div class="big-icon">N</div>
        <h2>Bharat Nova AI</h2>
        <p>Pick an engine from the pill in the top bar and start chatting. 14 AI engines are available across 4 intelligence tiers — if your chosen engine ever fails, Nova automatically transfers to the next highest-intelligence backup.</p>
      </div>`;
    return;
  }
  inner.innerHTML = chat.messages.map((m, i) => renderBubble(m, i)).join('');
  // KaTeX is synchronous — no post-render typeset call needed
  scrollChatToBottom(true);
}
function renderBubble(m, idx){
  const isUser = m.role === 'user';
  const avatar = isUser
    ? `<div class="avatar user">YOU</div>`
    : `<div class="avatar ai">N</div>`;
  const bubbleClass = m.error ? 'bubble error' : 'bubble';
  // User messages: plain escaped text. AI messages: full Markdown + Math rendering.
  const content = isUser ? escapeHtml(m.content) : renderContent(m.content);
  const attachmentHtml = renderBubbleAttachment(m.attachment);
  const hasText = !!(m.content && m.content.trim());
  const fallbackNote = m.fallback
    ? `<div class="fallback-note">⚡ System: ${escapeHtml(m.requestedEngineName||'')} failed → auto-answered via ${escapeHtml(m.engineName||'')}</div>`
    : '';
  const copyBtn = !isUser ? `<button class="copy-btn" onclick="copyMsg(${idx})">Copy</button>` : '';
  return `
    <div class="msg-row ${isUser?'user':'ai'}">
      ${avatar}
      <div class="bubble-col">
        ${attachmentHtml}
        ${hasText || !attachmentHtml ? `<div class="${bubbleClass}">${content}</div>` : ''}
        ${fallbackNote}
        ${!isUser ? `<div class="msg-meta"><span>${escapeHtml(m.engineName||'')}</span>${copyBtn}</div>` : ''}
      </div>
    </div>`;
}
function renderBubbleAttachment(att){
  if (!att) return '';
  if (att.isImage && att.dataUrl) {
    return `<img class="bubble-attach-img" src="${att.dataUrl}" alt="Attached image"/>`;
  }
  return `<div class="bubble-attach-file">📄 ${escapeHtml(att.name || 'Attached file')}</div>`;
}
function copyMsg(idx){
  const chat = getActiveChat();
  if (!chat) return;
  const m = chat.messages[idx];
  if (m) navigator.clipboard?.writeText(m.content);
}
function showTyping(){
  const inner = document.getElementById('chatInner');
  const row = document.createElement('div');
  row.className = 'msg-row ai';
  row.id = 'typingRow';
  row.innerHTML = `<div class="avatar ai">N</div><div class="bubble-col"><div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div></div>`;
  inner.appendChild(row);
  scrollChatToBottom(true);
}
function hideTyping(){
  document.getElementById('typingRow')?.remove();
}

/* Only auto-scroll if the user is already near the bottom, so manual
   scroll-up to read history is never jittered or yanked back down. */
function isNearBottom(){
  const wrap = document.getElementById('chatWrap');
  return wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 120;
}
function scrollChatToBottom(force){
  const wrap = document.getElementById('chatWrap');
  if (force || isNearBottom()) {
    wrap.scrollTo({ top: wrap.scrollHeight, behavior: 'smooth' });
  }
}

/* ══════════════════════════════════════════
   INPUT HANDLING
══════════════════════════════════════════ */
function autoGrow(el){
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}
function onInputKeydown(ev){
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    sendMessage();
  }
}

/* ══════════════════════════════════════════
   SEND MESSAGE → /api/server (auto-failsafe backend)
══════════════════════════════════════════ */
async function sendMessage(){
  const input = document.getElementById('msgInput');
  const text = input.value.trim();
  const attachment = pendingAttachment; // snapshot — current turn's attachment only
  if (!text && !attachment) return;

  let chat = getActiveChat();
  if (!chat) { newChat(); chat = getActiveChat(); }

  // Compact record kept in chat history for re-rendering the bubble.
  // Images keep their (already-compressed) preview; generic files only
  // keep their name/type, never re-sent on later turns.
  const attachmentForHistory = attachment ? {
    isImage: attachment.isImage,
    mimeType: attachment.mimeType,
    name: attachment.name,
    dataUrl: attachment.isImage ? attachment.dataUrl : null,
  } : null;

  chat.messages.push({ role:'user', content:text, attachment: attachmentForHistory });
  if (chat.title === 'New chat') {
    const fallbackTitle = attachment ? (attachment.isImage ? '📷 Photo' : `📄 ${attachment.name || 'File'}`) : 'New chat';
    chat.title = (text || fallbackTitle).slice(0, 40);
  }
  saveChats();
  renderHistory();
  renderMessages();

  input.value = '';
  autoGrow(input);
  clearAttachment();
  document.getElementById('sendBtn').disabled = true;
  showTyping();

  try {
    const res = await fetch('/api/server', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        engine: selectedEngine,
        temperature: 0.7,
        max_tokens: 1024,
        messages: chat.messages.map(m => ({ role:m.role, content:m.content })),
        ...(attachment ? { attachment: { mimeType: attachment.mimeType, data: attachment.base64, name: attachment.name } } : {}),
      }),
    });
    const data = await res.json();
    hideTyping();

    if (data.error) {
      chat.messages.push({ role:'assistant', content:`⚠️ ${data.message || 'All engines failed.'}`, error:true });
      showToast(`All engines failed for this request. Check your API keys in Vercel.`);
    } else {
      chat.messages.push({
        role:'assistant',
        content: data.reply,
        engine: data.engine,
        engineName: data.engineName,
        fallback: data.fallback,
        requestedEngineName: data.requestedEngineName,
      });
      if (data.fallback) {
        showToast(`System: ${data.requestedEngineName} failed. Automatically fetched answer via ${data.engineName}.`);
      }
    }
  } catch (err) {
    hideTyping();
    chat.messages.push({ role:'assistant', content:`⚠️ Network error: ${err?.message || 'request failed'}`, error:true });
  }

  saveChats();
  renderMessages();
  document.getElementById('sendBtn').disabled = false;
}

/* ══════════════════════════════════════════
   FIREBASE AUTH
══════════════════════════════════════════ */
(function initFirebaseAuth(){
  const fbCfg = {
    apiKey: "AIzaSyALc807O77-KGEYOnjpiFinC5zzDBN0EUk",
    authDomain: "bharat-ai-chatbot-7a1fa.firebaseapp.com",
    projectId: "bharat-ai-chatbot-7a1fa",
    storageBucket: "bharat-ai-chatbot-7a1fa.firebasestorage.app",
    messagingSenderId: "732391672860",
    appId: "1:732391672860:web:c7a5f41559bab298a0e3d9",
    measurementId: "G-ZEPZYFMKL0"
  };
  firebase.initializeApp(fbCfg);
  const auth = firebase.auth();
  auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

  auth.onAuthStateChanged(function(user){
    const screen = document.getElementById('authScreen');
    if (user) {
      screen.style.display = 'none';
      currentUser = user;
      const name = user.displayName || (user.email ? user.email.split('@')[0] : 'User');
      document.getElementById('sbUserAv').textContent = name.charAt(0).toUpperCase();
      document.getElementById('sbUserName').textContent = name;
      document.getElementById('sbUserEmail').textContent = user.email || '';
      loadChats();
      if (!chats.length) { newChat(); } else { activeChatId = chats[0].id; renderHistory(); renderMessages(); }
    } else {
      screen.style.display = 'flex';
      currentUser = null;
    }
  });

  window.switchAuthTab = function(tab){
    const isIn = tab === 'signin';
    document.getElementById('tabSignIn').classList.toggle('active', isIn);
    document.getElementById('tabSignUp').classList.toggle('active', !isIn);
    document.getElementById('formSignIn').style.display = isIn ? '' : 'none';
    document.getElementById('formSignUp').style.display = isIn ? 'none' : '';
    clearAuthErr('siErr'); clearAuthErr('suErr');
  };
  window.authTogglePw = function(id, btn){
    const inp = document.getElementById(id);
    const hidden = inp.type === 'password';
    inp.type = hidden ? 'text' : 'password';
    btn.textContent = hidden ? '🙈' : '👁';
  };
  function showAuthErr(id, msg){ const el=document.getElementById(id); el.textContent=msg; el.classList.add('on'); }
  function clearAuthErr(id){ document.getElementById(id).classList.remove('on'); }
  function setLoading(btnId, loading, label){
    const btn = document.getElementById(btnId);
    btn.disabled = loading;
    btn.innerHTML = loading ? '<span class="auth-spin"></span>Please wait…' : label;
  }
  function friendlyError(err){
    const map = {
      'auth/user-not-found':'No account found with this email.',
      'auth/wrong-password':'Incorrect password.',
      'auth/invalid-credential':'Incorrect email or password.',
      'auth/email-already-in-use':'An account with this email already exists.',
      'auth/weak-password':'Password should be at least 6 characters.',
      'auth/invalid-email':'Please enter a valid email address.',
      'auth/too-many-requests':'Too many attempts. Please try again later.',
    };
    return map[err.code] || err.message || 'Something went wrong. Please try again.';
  }

  window.handleSignIn = function(ev){
    ev.preventDefault();
    clearAuthErr('siErr');
    const email = document.getElementById('siEmail').value.trim();
    const pw = document.getElementById('siPw').value;
    setLoading('siSubmit', true, 'Sign In');
    auth.signInWithEmailAndPassword(email, pw)
      .catch(err => showAuthErr('siErr', friendlyError(err)))
      .finally(() => setLoading('siSubmit', false, 'Sign In'));
    return false;
  };
  window.handleSignUp = function(ev){
    ev.preventDefault();
    clearAuthErr('suErr');
    const name = document.getElementById('suName').value.trim();
    const email = document.getElementById('suEmail').value.trim();
    const pw = document.getElementById('suPw').value;
    setLoading('suSubmit', true, 'Create Account');
    auth.createUserWithEmailAndPassword(email, pw)
      .then(cred => cred.user.updateProfile({ displayName: name }))
      .catch(err => showAuthErr('suErr', friendlyError(err)))
      .finally(() => setLoading('suSubmit', false, 'Create Account'));
    return false;
  };
  window.doSignOut = function(){ auth.signOut(); };
})();

/* ══════════════════════════════════════════
   INIT
══════════════════════════════════════════ */
updatePillUI();
renderEngineMenu();

/* ══════════════════════════════════════════
   PWA: SERVICE WORKER REGISTRATION
══════════════════════════════════════════ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(err => console.warn('SW registration failed:', err));
  });
}
