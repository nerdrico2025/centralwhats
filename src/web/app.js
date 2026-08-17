/* WA Manager — SPA shell (Vanilla JS, sem framework/bundler).
   Roteamento client-side, seletor de instância global e API client que injeta
   o instance_id atual. Telas são placeholders (Fase 2+), exceto Instâncias. */

'use strict';

// ------------------------------------------------------------------- sessão
// V2: token JWT + usuário em localStorage. Sem usuários cadastrados a API
// opera em modo bootstrap (org default, sem login) — o painel detecta pelo 401.
const auth = {
  token: localStorage.getItem('wa.jwt'),
  user: JSON.parse(localStorage.getItem('wa.user') || 'null'),
  // Sessão vinda de GET /api/me: conta ativa, papel NELA e as contas do
  // usuário (modelo agência — a mesma pessoa administra várias contas).
  session: null,
  set(token, user) {
    this.token = token;
    this.user = user;
    localStorage.setItem('wa.jwt', token);
    localStorage.setItem('wa.user', JSON.stringify(user));
  },
  clear() {
    this.token = null;
    this.user = null;
    this.session = null;
    localStorage.removeItem('wa.jwt');
    localStorage.removeItem('wa.user');
  },
  role() {
    // O papel É POR CONTA: quem manda é a sessão, não o que ficou salvo no
    // localStorage de um login anterior (podia ser owner em outra conta).
    if (this.session) return this.session.role;
    return this.user ? this.user.role : 'owner'; // bootstrap = owner
  },
  orgs() {
    return this.session ? this.session.orgs || [] : [];
  },
  activeOrgId() {
    return this.session ? this.session.active_org_id : null;
  },
};

// ----------------------------------------------------------------- API client
const api = {
  currentInstanceId: null,

  async raw(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(auth.token ? { Authorization: 'Bearer ' + auth.token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      // Sessão inválida/expirada (ou sistema trancado): volta pro login.
      auth.clear();
      renderLoginScreen();
      throw new Error('Não autenticado');
    }
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json()).error || '';
      } catch {
        /* corpo não-JSON: ignora */
      }
      throw new Error(detail || `HTTP ${res.status}`);
    }
    return res.status === 204 ? null : res.json();
  },
  get(path) {
    return this.raw('GET', path);
  },
  post(path, body) {
    return this.raw('POST', path, body);
  },
  del(path) {
    return this.raw('DELETE', path);
  },
  patch(path, body) {
    return this.raw('PATCH', path, body);
  },

  /** Monta um path escopado na instância atual: injeta o instance_id. */
  forInstance(suffix) {
    if (!this.currentInstanceId) throw new Error('Nenhuma instância selecionada');
    return `/api/instances/${this.currentInstanceId}${suffix}`;
  },

  listInstances() {
    return this.get('/api/instances');
  },
};

// ------------------------------------------------------------------ app state
const state = {
  instances: [],
  route: '/dashboard',
};

// ------------------------------------------------- estrutura de navegação (§12)
const NAV = [
  {
    section: 'PRINCIPAL',
    items: [
      { path: '/dashboard', label: 'Dashboard', icon: '▤' },
      { path: '/instancias', label: 'Instâncias', icon: '☰' },
    ],
  },
  {
    section: 'ENVIOS',
    items: [
      { path: '/disparar', label: 'Disparar Mensagem', icon: '✉' },
      { path: '/disparo-massa', label: 'Disparo em Massa', icon: '📢' },
      { path: '/templates', label: 'Templates', icon: '▦' },
    ],
  },
  {
    section: 'ATENDIMENTO',
    items: [
      { path: '/livechat', label: 'Live Chat', icon: '💬', badgeKey: 'unread' },
      { path: '/chatbot', label: 'Chatbot', icon: '🤖' },
    ],
  },
  {
    section: 'MARKETING',
    items: [
      { path: '/contatos', label: 'Contatos', icon: '👤' },
      { path: '/listas', label: 'Listas', icon: '≣' },
      { path: '/crm', label: 'CRM', icon: '◱' },
      { path: '/campanhas', label: 'Campanhas', icon: '◎' },
    ],
  },
  {
    section: 'ANÁLISE',
    items: [
      { path: '/relatorios', label: 'Relatórios', icon: '▧' },
      { path: '/faturamento', label: 'Faturamento', icon: '$' },
    ],
  },
  {
    section: 'CONFIGURAÇÕES',
    items: [{ path: '/usuarios', label: 'Equipe', icon: '👥' }],
  },
];

// Papel 'agent' só atende: enxerga apenas o Live Chat (o backend já dá 403
// no resto — aqui a UI esconde o que ele não pode usar).
function visibleNav() {
  if (auth.role() !== 'agent') return NAV;
  return [
    {
      section: 'ATENDIMENTO',
      items: [{ path: '/livechat', label: 'Live Chat', icon: '💬', badgeKey: 'unread' }],
    },
    // A tela de Equipe mostra só o cartão de senha para o agent — sem ela ele
    // não teria como trocar a própria senha pelo painel.
    {
      section: 'CONFIGURAÇÕES',
      items: [{ path: '/usuarios', label: 'Minha conta', icon: '👤' }],
    },
  ];
}

const BADGES = { unread: 0 }; // preenchido na Fase 2 (Live Chat)

// ----------------------------------------------------------------- utilidades
function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v != null) el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

function pageHeader(title, subtitle) {
  return h('div', {}, [
    h('h1', { class: 'page-title' }, title),
    subtitle ? h('p', { class: 'page-subtitle' }, subtitle) : null,
  ]);
}

function placeholderScreen(title, subtitle, emoji) {
  return h('div', {}, [
    pageHeader(title, subtitle),
    h('div', { class: 'card' }, [
      h('div', { class: 'placeholder' }, [
        h('div', { class: 'placeholder__emoji' }, emoji || '🚧'),
        h('div', {}, 'Tela em construção — chega nas próximas fases.'),
      ]),
    ]),
  ]);
}

// -------------------------------------------------------------------- screens
// --------------------------------------------------------- helpers SVG (P2.3)
const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, children = []) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const c of [].concat(children)) if (c != null) el.appendChild(c);
  return el;
}
const CHART_COLORS = ['#25d366', '#3b82f6', '#f59e0b', '#8b5cf6', '#14b8a6', '#ef4444', '#64748b'];

/** Gráfico de área: enviadas (verde) vs recebidas (azul) nos últimos 30 dias. */
function areaChart(series) {
  const W = 640;
  const H = 220;
  const padL = 34;
  const padR = 10;
  const padT = 12;
  const padB = 22;
  const n = series.length;
  const maxV = Math.max(1, ...series.map((d) => Math.max(d.sent, d.received)));
  const x = (i) => padL + (i * (W - padL - padR)) / Math.max(1, n - 1);
  const y = (v) => padT + (H - padT - padB) * (1 - v / maxV);
  const baseline = y(0);

  function pathFor(key) {
    const pts = series.map((d, i) => `${x(i)},${y(d[key])}`);
    return {
      line: 'M' + pts.join(' L'),
      area: `M${x(0)},${baseline} L` + pts.join(' L') + ` L${x(n - 1)},${baseline} Z`,
    };
  }
  const sent = pathFor('sent');
  const recv = pathFor('received');

  const gridLines = [0, 0.5, 1].map((f) =>
    svg('line', {
      x1: padL,
      x2: W - padR,
      y1: padT + (H - padT - padB) * f,
      y2: padT + (H - padT - padB) * f,
      stroke: '#e2e8f0',
    }),
  );
  // rótulos de x: primeiro, meio, último
  const xticks = [0, Math.floor(n / 2), n - 1].map((i) =>
    svg('text', { x: x(i), y: H - 6, 'font-size': 10, fill: '#94a3b8', 'text-anchor': 'middle' }, [
      document.createTextNode(series[i] ? series[i].date.slice(5) : ''),
    ]),
  );
  const ymax = svg('text', { x: 4, y: padT + 8, 'font-size': 10, fill: '#94a3b8' }, [
    document.createTextNode(String(maxV)),
  ]);

  return svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' }, [
    ...gridLines,
    svg('path', { d: recv.area, fill: '#3b82f6', opacity: 0.12 }),
    svg('path', { d: recv.line, fill: 'none', stroke: '#3b82f6', 'stroke-width': 2 }),
    svg('path', { d: sent.area, fill: '#25d366', opacity: 0.14 }),
    svg('path', { d: sent.line, fill: 'none', stroke: '#25d366', 'stroke-width': 2 }),
    ...xticks,
    ymax,
  ]);
}

/** Donut de distribuição por tipo de mensagem. */
function donutChart(items) {
  const total = items.reduce((s, i) => s + i.count, 0);
  const cx = 80;
  const cy = 80;
  const r = 70;
  const ri = 44;
  const paths = [];
  if (total === 0) {
    paths.push(svg('circle', { cx, cy, r: (r + ri) / 2, fill: 'none', stroke: '#e2e8f0', 'stroke-width': r - ri }));
  } else {
    let a0 = -Math.PI / 2;
    items.forEach((it, idx) => {
      const a1 = a0 + (it.count / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (rad, ang) => `${cx + rad * Math.cos(ang)},${cy + rad * Math.sin(ang)}`;
      const d = `M${p(r, a0)} A${r},${r} 0 ${large} 1 ${p(r, a1)} L${p(ri, a1)} A${ri},${ri} 0 ${large} 0 ${p(ri, a0)} Z`;
      paths.push(svg('path', { d, fill: CHART_COLORS[idx % CHART_COLORS.length] }));
      a0 = a1;
    });
  }
  const chart = svg('svg', { viewBox: '0 0 160 160', width: 160, height: 160 }, paths);
  const legend = h(
    'div',
    { class: 'legend' },
    items.map((it, idx) =>
      h('span', { class: 'legend__item' }, [
        h('span', {
          class: 'legend__dot',
          style: `background:${CHART_COLORS[idx % CHART_COLORS.length]}`,
        }),
        `${it.type} (${it.count})`,
      ]),
    ),
  );
  return h('div', { class: 'donut-wrap' }, [chart, legend]);
}

const screens = {
  '/dashboard': () => dashboardScreen(),

  '/instancias': () => instanciasScreen(),

  '/disparar': () => dispararScreen(),
  '/disparo-massa': () =>
    placeholderScreen('Disparo em Massa', 'Use a tela Campanhas para disparos em massa.', '📢'),
  '/templates': () => templatesScreen(),
  '/livechat': () => livechatScreen(),
  '/chatbot': () => chatbotScreen(),
  '/contatos': () => contatosScreen(),
  '/listas': () => listasScreen(),
  '/crm': () => crmScreen(),
  '/campanhas': () => campanhasScreen(),
  '/relatorios': () => placeholderScreen('Relatórios', 'Análises e exportações.', '▧'),
  '/faturamento': () => placeholderScreen('Faturamento', 'Custos e cobrança.', '$'),
  '/usuarios': () => usuariosScreen(),
};

// ------------------------------------------------------------- Live Chat (P2.2)
function messageText(type, content) {
  const c = content || {};
  switch (type) {
    case 'text':
      // inbound loga { body }; outbound loga { text } — tolera os dois.
      return c.body || c.text || '';
    case 'image':
      return '🖼️ [imagem]';
    case 'video':
      return '🎬 [vídeo]';
    case 'audio':
      return '🔊 [áudio]';
    case 'document':
      return '📎 ' + (c.filename || '[documento]');
    case 'sticker':
      return '[sticker]';
    case 'interactive':
      return c.title || c.body || '[interativo]';
    case 'button':
      return c.text || '[botão]';
    case 'template':
      return '[template ' + (c.template?.name || '') + ']';
    case 'reaction':
      return c.emoji || '[reação]';
    default:
      return '[' + type + ']';
  }
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function livechatScreen() {
  const listEl = h('div', { class: 'conv-list' });
  const rightEl = h('div', {});
  // screen--full: sem esta classe o root fica com altura `auto` e o
  // `height: 100%` do .livechat não tem contra o que resolver — o composer sai
  // da tela em conversa longa. Ver o comentário grande em styles.css.
  const root = h('div', { class: 'screen--full' }, [
    pageHeader('Live Chat', 'Conversas em tempo real.'),
    h('div', { class: 'livechat' }, [listEl, rightEl]),
  ]);

  let selected = null;
  let convs = [];
  // Erro da última carga da lista. Sem isso, QUALQUER falha (rede, 401, 500,
  // instância não selecionada) vira "Sem conversas ainda" — que foi exatamente
  // o que mascarou o diagnóstico do Live Chat. CLAUDE.md: nada de erro engolido.
  let listError = null;

  function previewOf(c) {
    const prefix = c.last_message_direction === 'out' ? 'Você: ' : '';
    return prefix + messageText(c.last_message_type, c.last_message_content);
  }

  function renderList() {
    listEl.innerHTML = '';
    if (listError) {
      listEl.appendChild(
        h('div', { class: 'placeholder placeholder--error' }, [
          h('strong', {}, 'Não foi possível carregar as conversas.'),
          h('div', { class: 'muted' }, listError),
        ]),
      );
      return;
    }
    if (!convs.length) {
      listEl.appendChild(h('div', { class: 'placeholder' }, 'Sem conversas ainda.'));
      return;
    }
    for (const c of convs) {
      listEl.appendChild(
        h(
          'div',
          {
            class: 'conv-item' + (c.phone === selected ? ' active' : ''),
            onclick: () => selectConversation(c.phone),
          },
          [
            h('div', { class: 'conv-item__top' }, [
              h('span', { class: 'conv-item__name' }, c.name || c.phone),
              c.unread ? h('span', { class: 'conv-unread' }, String(c.unread)) : null,
            ]),
            h('div', { class: 'conv-item__preview' }, previewOf(c)),
          ],
        ),
      );
    }
  }

  async function loadConversations() {
    try {
      convs = await api.get(api.forInstance('/conversations'));
      listError = null;
    } catch (e) {
      convs = [];
      listError = e.message;
      console.error('[livechat] falha ao carregar conversas:', e);
    }
    renderList();
    // Atualiza o badge de não-lidas do menu (soma das conversas).
    const total = convs.reduce((s, c) => s + (c.unread || 0), 0);
    if (BADGES.unread !== total) {
      BADGES.unread = total;
      refreshSidebar();
    }
  }

  // === Conversa aberta: nós ESTÁVEIS ===
  //
  // O composer NUNCA é recriado enquanto a conversa aberta é a mesma. Antes,
  // renderConversation() fazia `rightEl.innerHTML = ''` e remontava a árvore
  // inteira — inclusive um <textarea> novo. Como o polling de 4s chama
  // loadMessages(), cada tick apagava o que estava sendo digitado e roubava o
  // foco. É o mesmo defeito do bug da tela de login (90a1dbc): trabalho
  // periódico redesenhando por cima da entrada do usuário.
  //
  // O padrão aqui é o mesmo do resto do painel (listCard/sideCard/convitesCard):
  // containers fixos, preenchidos de novo — em vez de recriar a árvore.
  let aberta = null; // { phone, nomeEl, msgsEl, input }

  /** Monta a casca da conversa. Só quando a conversa muda DE VERDADE. */
  function montarConversa() {
    const conv = convs.find((c) => c.phone === selected);
    const nomeEl = h('strong', {}, (conv && conv.name) || selected);
    const header = h('div', { class: 'conversation__header' }, [
      nomeEl,
      ' ',
      h('span', { class: 'muted' }, selected),
    ]);
    const msgsEl = h('div', { class: 'conversation__messages' });
    const input = h('textarea', {
      class: 'composer__input',
      rows: '1',
      placeholder: 'Digite uma mensagem…',
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend(input);
      }
    });
    const composer = h('div', { class: 'conversation__composer' }, [
      input,
      h('button', { class: 'btn btn--primary', onclick: () => doSend(input) }, 'Enviar'),
    ]);

    rightEl.innerHTML = '';
    rightEl.appendChild(h('div', { class: 'conversation' }, [header, msgsEl, composer]));
    aberta = { phone: selected, nomeEl, msgsEl, input };
  }

  /** Garante a casca da conversa atual sem tocar no composer se já é a mesma. */
  function garantirConversa() {
    if (!aberta || aberta.phone !== selected) montarConversa();
  }

  /**
   * Atualiza SÓ a lista de mensagens (o único dado que muda a cada tick).
   * Nunca toca no composer — nem no erro: a falha aparece na área das
   * mensagens, e o texto digitado continua onde estava.
   */
  function renderMensagens(msgs, error) {
    if (!aberta) return;
    const { msgsEl } = aberta;

    const conv = convs.find((c) => c.phone === selected);
    aberta.nomeEl.textContent = (conv && conv.name) || selected;

    // Só rola pro fim se o usuário JÁ estava no fim — senão o polling puxaria
    // a rolagem no meio da leitura do histórico.
    const distanciaDoFim =
      Number(msgsEl.scrollHeight || 0) - Number(msgsEl.scrollTop || 0) - Number(msgsEl.clientHeight || 0);
    const estavaNoFim = !(distanciaDoFim > 40);

    msgsEl.innerHTML = '';
    if (error) {
      msgsEl.appendChild(
        h('div', { class: 'placeholder placeholder--error' }, [
          h('strong', {}, 'Não foi possível carregar o histórico.'),
          h('div', { class: 'muted' }, error),
        ]),
      );
      return;
    }
    for (const mm of msgs) {
      msgsEl.appendChild(
        h('div', { class: 'bubble bubble--' + (mm.direction === 'in' ? 'in' : 'out') }, [
          h('div', {}, messageText(mm.type, mm.content)),
          h('div', { class: 'bubble__time' }, formatTime(mm.created_at)),
        ]),
      );
    }
    if (estavaNoFim) msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  async function loadMessages() {
    if (!selected) return;
    garantirConversa();
    let msgs = [];
    try {
      msgs = await api.get(
        api.forInstance(`/conversations/${encodeURIComponent(selected)}/messages?limit=200`),
      );
    } catch (e) {
      console.error('[livechat] falha ao carregar mensagens:', e);
      renderMensagens([], e.message);
      return;
    }
    renderMensagens(msgs.slice().reverse()); // repo retorna DESC; exibe ASC
  }

  async function selectConversation(phone) {
    selected = phone;
    try {
      await api.post(api.forInstance(`/conversations/${encodeURIComponent(phone)}/read`));
    } catch {
      /* segue mesmo se falhar o read */
    }
    await loadMessages();
    await loadConversations(); // zera não-lidas na lista e no badge
  }

  async function doSend(input) {
    const text = input.value.trim();
    if (!text || !selected) return;
    input.value = '';
    try {
      await api.post(api.forInstance('/messages'), { type: 'text', to: selected, text });
    } catch (e) {
      alert('Falha ao enviar: ' + e.message);
    }
    await loadMessages();
    await loadConversations();
  }

  rightEl.appendChild(h('div', { class: 'placeholder' }, 'Selecione uma conversa.'));

  loadConversations();
  // Atualização por POLLING curto (sem WebSocket na camada web — serverless).
  const timer = setInterval(() => {
    loadConversations();
    if (selected) loadMessages();
  }, 4000);
  registerCleanup(() => clearInterval(timer));

  return root;
}

// ------------------------------------------------------------- Dashboard (P2.3)
function dashboardScreen() {
  const body = h('div', {}, [h('div', { class: 'muted' }, 'Carregando…')]);
  const root = h('div', {}, [pageHeader('Dashboard', 'Visão geral das suas métricas.'), body]);

  const pct = (v) => (v * 100).toFixed(1) + '%';
  const stat = (label, value) =>
    h('div', { class: 'card stat' }, [
      h('span', { class: 'stat__label' }, label),
      h('span', { class: 'stat__value' }, String(value)),
    ]);
  const legendDot = (color, label) =>
    h('span', { class: 'legend__item' }, [
      h('span', { class: 'legend__dot', style: 'background:' + color }),
      label,
    ]);

  (async () => {
    let data;
    try {
      data = await api.get(api.forInstance('/dashboard'));
    } catch (e) {
      body.innerHTML = '';
      body.appendChild(h('div', { class: 'muted' }, 'Erro ao carregar: ' + e.message));
      return;
    }
    body.innerHTML = '';

    body.appendChild(
      h('div', { class: 'stat-row' }, [
        stat('Mensagens Enviadas', data.sent),
        stat('Mensagens Recebidas', data.received),
        stat('Contatos', data.contacts),
        stat('Instâncias Ativas', data.active_instances),
        stat('Taxa de Entrega', pct(data.delivery_rate)),
        stat('Taxa de Leitura', pct(data.read_rate)),
      ]),
    );

    body.appendChild(
      h('div', { class: 'card chart' }, [
        h('h3', { class: 'card__title' }, 'Volume — Últimos 30 dias'),
        areaChart(data.volume_30d),
        h('div', { class: 'legend' }, [
          legendDot('#25d366', 'Enviadas'),
          legendDot('#3b82f6', 'Recebidas'),
        ]),
      ]),
    );

    const donutCard = h('div', { class: 'card' }, [
      h('h3', { class: 'card__title' }, 'Tipos de Mensagem'),
      donutChart(data.by_type),
    ]);
    const rows = data.by_instance.map((i) =>
      h('tr', {}, [h('td', {}, i.name), h('td', {}, String(i.total))]),
    );
    const tableCard = h('div', { class: 'card' }, [
      h('h3', { class: 'card__title' }, 'Volume por Instância'),
      h('table', { class: 'table' }, [
        h('thead', {}, [h('tr', {}, [h('th', {}, 'Instância'), h('th', {}, 'Mensagens')])]),
        h('tbody', {}, rows),
      ]),
    ]);
    body.appendChild(h('div', { class: 'dash-grid' }, [donutCard, tableCard]));
  })();

  return root;
}

// ------------------------------------------------------------- Listas (P3.1)
function listasScreen() {
  const leftCard = h('div', { class: 'card' });
  const rightCard = h('div', { class: 'card' });
  const root = h('div', {}, [
    pageHeader('Listas', 'Segmentação de contatos.'),
    h('div', { class: 'dash-grid' }, [leftCard, rightCard]),
  ]);

  let lists = [];
  let selected = null;

  async function loadLists() {
    lists = await api.get(api.forInstance('/lists')).catch(() => []);
    renderLists();
  }

  function renderLists() {
    leftCard.innerHTML = '';
    leftCard.appendChild(h('h3', { class: 'card__title' }, 'Listas'));
    const nameInput = h('input', { class: 'select', placeholder: 'Nova lista' });
    leftCard.appendChild(
      h('div', { style: 'display:flex;gap:8px;margin-bottom:12px' }, [
        nameInput,
        h(
          'button',
          {
            class: 'btn btn--primary',
            onclick: async () => {
              const name = nameInput.value.trim();
              if (!name) return;
              await api.post(api.forInstance('/lists'), { name });
              nameInput.value = '';
              loadLists();
            },
          },
          'Criar',
        ),
      ]),
    );
    if (!lists.length) {
      leftCard.appendChild(h('div', { class: 'muted' }, 'Nenhuma lista ainda.'));
      return;
    }
    const rows = lists.map((l) =>
      h('tr', {}, [
        h('td', { style: 'cursor:pointer', onclick: () => selectList(l) }, l.name),
        h('td', {}, [
          h(
            'button',
            {
              class: 'btn',
              onclick: async () => {
                await api.raw('DELETE', api.forInstance('/lists/' + l.id));
                if (selected && selected.id === l.id) selected = null;
                loadLists();
                renderRight();
              },
            },
            'Excluir',
          ),
        ]),
      ]),
    );
    leftCard.appendChild(h('table', { class: 'table' }, [h('tbody', {}, rows)]));
  }

  function selectList(l) {
    selected = l;
    renderRight();
  }

  async function renderRight() {
    rightCard.innerHTML = '';
    if (!selected) {
      rightCard.appendChild(h('div', { class: 'placeholder' }, 'Selecione uma lista.'));
      return;
    }
    rightCard.appendChild(h('h3', { class: 'card__title' }, 'Contatos de "' + selected.name + '"'));
    const inList = await api.get(api.forInstance('/lists/' + selected.id + '/contacts')).catch(() => []);
    if (inList.length) {
      rightCard.appendChild(
        h('table', { class: 'table' }, [
          h('tbody', {}, inList.map((c) =>
            h('tr', {}, [
              h('td', {}, c.name || c.phone),
              h('td', {}, [
                h(
                  'button',
                  {
                    class: 'btn',
                    onclick: async () => {
                      await api.post(api.forInstance('/lists/' + selected.id + '/contacts/remove'), {
                        contactIds: [c.id],
                      });
                      renderRight();
                    },
                  },
                  'Remover',
                ),
              ]),
            ]),
          )),
        ]),
      );
    } else {
      rightCard.appendChild(h('div', { class: 'muted' }, 'Nenhum contato nesta lista.'));
    }

    // Adicionar contatos: multi-select dos que ainda não estão na lista.
    const all = await api.get(api.forInstance('/contacts')).catch(() => []);
    const ids = new Set(inList.map((c) => c.id));
    const candidates = all.filter((c) => !ids.has(c.id));
    if (candidates.length) {
      const sel = h(
        'select',
        { class: 'select', multiple: 'multiple', style: 'min-height:120px;width:100%' },
        candidates.map((c) => h('option', { value: c.id }, c.name || c.phone)),
      );
      rightCard.appendChild(h('div', { style: 'margin-top:12px' }, [
        h('div', { class: 'muted', style: 'margin-bottom:6px' }, 'Adicionar contatos:'),
        sel,
        h(
          'button',
          {
            class: 'btn btn--primary',
            style: 'margin-top:8px',
            onclick: async () => {
              const chosen = [...sel.selectedOptions].map((o) => o.value);
              if (!chosen.length) return;
              await api.post(api.forInstance('/lists/' + selected.id + '/contacts'), {
                contactIds: chosen,
              });
              renderRight();
            },
          },
          'Adicionar selecionados',
        ),
      ]));
    }
  }

  loadLists();
  renderRight();
  return root;
}

// ------------------------------------------------------------- Campanhas (P3.2)

/** Rótulo + classe de badge por status de envio/campanha. */
const CAMPAIGN_STATUS = {
  draft: { label: 'rascunho', badge: 'badge' },
  running: { label: 'em andamento', badge: 'badge badge--warn' },
  paused: { label: 'pausada', badge: 'badge' },
  completed: { label: 'concluída', badge: 'badge badge--ok' },
};
const SEND_STATUS = {
  pending: { label: 'na fila', badge: 'badge' },
  sending: { label: 'enviando', badge: 'badge badge--warn' },
  sent: { label: 'enviado', badge: 'badge badge--ok' },
  failed: { label: 'falhou', badge: 'badge badge--off' },
};
function statusBadge(map, status) {
  const s = map[status] || { label: status, badge: 'badge' };
  return h('span', { class: s.badge }, s.label);
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleString('pt-BR');
}

/**
 * Deriva do template SINCRONIZADO quais variáveis ele espera, para o operador
 * não ter que adivinhar o número de cada {{n}}. Segue exatamente a convenção
 * de chaves de providers/templateComponents.ts — se divergir daqui, a Meta
 * rejeita o envio por contagem de parâmetros.
 */
function expectedTemplateVars(template) {
  const slots = [];
  const comps = Array.isArray(template && template.components) ? template.components : [];
  const placeholders = (text) => {
    const found = String(text || '').match(/\{\{\s*(\d+)\s*\}\}/g) || [];
    return found.map((p) => p.replace(/[^\d]/g, ''));
  };

  for (const comp of comps) {
    const type = String((comp && comp.type) || '').toUpperCase();
    const example = (comp && comp.example) || {};

    if (type === 'HEADER') {
      const format = String(comp.format || 'TEXT').toUpperCase();
      if (format === 'TEXT') {
        if (placeholders(comp.text).length) {
          const hint = (example.header_text || [])[0];
          slots.push({ key: 'header', label: 'Header {{1}}', hint, suggested: 'name' });
        }
      } else {
        // Header de mídia: a Meta espera um link público (ou id já subido).
        slots.push({
          key: 'headerMedia',
          label: `Header ${format} (URL da mídia)`,
          hint: 'URL pública do arquivo — use lit:https://...',
          suggested: '',
        });
      }
    }

    if (type === 'BODY') {
      const hints = (example.body_text || [])[0] || [];
      for (const n of placeholders(comp.text)) {
        slots.push({
          key: n,
          label: 'Corpo {{' + n + '}}',
          hint: hints[Number(n) - 1],
          suggested: n === '1' ? 'name' : '',
        });
      }
    }

    if (type === 'BUTTONS' && Array.isArray(comp.buttons)) {
      comp.buttons.forEach((btn, idx) => {
        const btnType = String((btn && btn.type) || '').toUpperCase();
        if (btnType === 'URL' && placeholders(btn.url).length) {
          slots.push({
            key: 'button' + idx,
            label: `Botão ${idx} "${btn.text || ''}" (sufixo da URL)`,
            hint: (btn.example || [])[0],
            suggested: '',
          });
        }
      });
    }
  }
  return slots;
}

/** Texto do template para o operador conferir o que vai sair. */
function templateBodyPreview(template) {
  const comps = Array.isArray(template && template.components) ? template.components : [];
  const body = comps.find((c) => String((c && c.type) || '').toUpperCase() === 'BODY');
  return body && body.text ? body.text : '';
}

function campanhasScreen() {
  const formCard = h('div', { class: 'card' });
  const listCard = h('div', { class: 'card' });
  const detailCard = h('div', { class: 'card', style: 'margin-top:16px' });
  const root = h('div', {}, [
    pageHeader(
      'Campanhas',
      'Monte, dispare e audite campanhas. O disparo é retomável e continua sozinho — não precisa deixar esta tela aberta.',
    ),
    h('div', { class: 'dash-grid' }, [formCard, listCard]),
    detailCard,
  ]);

  let selectedId = null;

  // ------------------------------------------------------------------ lista
  async function loadCampaigns() {
    let camps;
    try {
      camps = await api.get(api.forInstance('/campaigns'));
    } catch (e) {
      // Falha de carga NUNCA pode virar "nenhuma campanha" (lição do Live Chat).
      listCard.innerHTML = '';
      listCard.appendChild(h('h3', { class: 'card__title' }, 'Campanhas'));
      listCard.appendChild(
        h('div', { class: 'placeholder placeholder--error' }, 'Erro ao carregar: ' + e.message),
      );
      return;
    }

    listCard.innerHTML = '';
    listCard.appendChild(h('h3', { class: 'card__title' }, 'Campanhas'));
    if (!camps.length) {
      listCard.appendChild(h('div', { class: 'muted' }, 'Nenhuma campanha ainda.'));
      return;
    }

    listCard.appendChild(
      h('table', { class: 'table' }, [
        h('thead', {}, [
          h('tr', {}, [
            h('th', {}, 'Nome'),
            h('th', {}, 'Status'),
            h('th', {}, 'Progresso'),
            h('th', {}, 'Criada em'),
            h('th', {}, ''),
          ]),
        ]),
        h(
          'tbody',
          {},
          camps.map((c) => {
            const done = (c.sent_count || 0) + (c.failed_count || 0);
            const progresso = h('div', {}, [
              h('span', {}, `${done}/${c.total_recipients}`),
              c.failed_count
                ? h('span', { class: 'muted' }, ` · ${c.failed_count} falha(s)`)
                : null,
            ]);

            // A API recusa deletar campanha 'running' (409). A UI reflete isso
            // desabilitando o botão em vez de deixar o operador errar.
            const running = c.status === 'running';
            const delBtn = h(
              'button',
              {
                class: 'btn',
                title: running
                  ? 'Pause a campanha antes de excluir — ela está disparando agora.'
                  : 'Excluir campanha e toda a auditoria dela',
                ...(running ? { disabled: 'disabled', style: 'opacity:.45;cursor:not-allowed' } : {}),
                onclick: async (ev) => {
                  ev.stopPropagation();
                  if (running) return;
                  const msg =
                    `Excluir a campanha "${c.name}"?\n\n` +
                    `Isto apaga também os ${done} registro(s) de envio dela (auditoria). ` +
                    'Não dá para desfazer.';
                  if (!confirm(msg)) return;
                  try {
                    await api.del(api.forInstance('/campaigns/' + c.id));
                    if (selectedId === c.id) {
                      selectedId = null;
                      renderEmptyDetail();
                    }
                    await loadCampaigns();
                  } catch (e) {
                    alert('Erro ao excluir: ' + e.message);
                  }
                },
              },
              'Excluir',
            );

            return h(
              'tr',
              {
                style: 'cursor:pointer' + (selectedId === c.id ? ';background:#f8fafc' : ''),
                onclick: () => openDetail(c.id),
              },
              [
                h('td', {}, c.name),
                h('td', {}, [statusBadge(CAMPAIGN_STATUS, c.status)]),
                h('td', {}, [progresso]),
                h('td', { class: 'muted' }, fmtDateTime(c.created_at)),
                h('td', {}, [delBtn]),
              ],
            );
          }),
        ),
      ]),
    );
  }

  // --------------------------------------------------------------- detalhe
  // Polling do disparo: enquanto running, a UI chama /tick (idempotente) para
  // dar ritmo imediato. O cron da Vercel faz o mesmo trabalho sozinho — fechar
  // a tela não para mais a campanha.
  let dispatchTimer = null;
  function stopDispatchPolling() {
    if (dispatchTimer) {
      clearInterval(dispatchTimer);
      dispatchTimer = null;
    }
  }
  registerCleanup(() => stopDispatchPolling());

  function renderEmptyDetail() {
    detailCard.innerHTML = '';
    detailCard.appendChild(
      h('div', { class: 'muted' }, 'Crie ou selecione uma campanha para ver os detalhes.'),
    );
  }

  async function openDetail(campaignId) {
    stopDispatchPolling();
    selectedId = campaignId;
    detailCard.innerHTML = '';

    let campaign;
    try {
      campaign = await api.get(api.forInstance('/campaigns/' + campaignId));
    } catch (e) {
      detailCard.appendChild(
        h('div', { class: 'placeholder placeholder--error' }, 'Erro ao carregar: ' + e.message),
      );
      return;
    }

    const title = h('h3', { class: 'card__title' }, 'Campanha "' + campaign.name + '"');
    const statusLine = h('div', { class: 'muted', style: 'margin-bottom:10px' });
    const controls = h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px' });
    const filterBar = h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px' });
    // Lista longa: altura própria e rolagem interna. Sem isto a tabela empurra
    // o resto da página (mesmo bug que já voltou 2x no Live Chat).
    const sendsWrap = h('div', {
      style: 'max-height:420px;overflow:auto;border-top:1px solid var(--border)',
    });
    detailCard.appendChild(title);
    detailCard.appendChild(statusLine);
    detailCard.appendChild(controls);
    detailCard.appendChild(filterBar);
    detailCard.appendChild(sendsWrap);

    let filtro = 'todos';

    function renderStatus(c, counts) {
      statusLine.innerHTML = '';
      const parts = [
        'Total: ' + c.total_recipients,
        'Enviados: ' + c.sent_count,
        'Falhas: ' + c.failed_count,
      ];
      if (counts) parts.push('Na fila: ' + counts.pending);
      statusLine.appendChild(statusBadge(CAMPAIGN_STATUS, c.status));
      statusLine.appendChild(h('span', {}, ' · ' + parts.join(' · ')));
    }
    renderStatus(campaign, null);

    /** Tabela de campaign_sends — a auditoria "logue tudo" virando tela. */
    async function renderSends() {
      let sends;
      try {
        const suffix = filtro === 'todos' ? '' : '?status=' + filtro;
        sends = await api.get(api.forInstance('/campaigns/' + campaignId + '/sends' + suffix));
      } catch (e) {
        sendsWrap.innerHTML = '';
        sendsWrap.appendChild(
          h('div', { class: 'placeholder placeholder--error' }, 'Erro ao carregar envios: ' + e.message),
        );
        return;
      }

      sendsWrap.innerHTML = '';
      if (!sends.length) {
        sendsWrap.appendChild(
          h('div', { class: 'muted', style: 'padding:14px' },
            filtro === 'todos'
              ? 'A fila ainda não foi materializada — inicie o disparo.'
              : 'Nenhum envio com este status.'),
        );
        return;
      }
      sendsWrap.appendChild(
        h('table', { class: 'table' }, [
          h('thead', {}, [
            h('tr', {}, [
              h('th', {}, 'Telefone'),
              h('th', {}, 'Status'),
              h('th', {}, 'Motivo da falha'),
              h('th', {}, 'Tentativas'),
              h('th', {}, 'Enviado em'),
            ]),
          ]),
          h(
            'tbody',
            {},
            sends.map((s) =>
              h('tr', {}, [
                h('td', {}, s.contact_phone),
                h('td', {}, [statusBadge(SEND_STATUS, s.status)]),
                // Código + mensagem juntos: é o que identifica o erro na Meta.
                h('td', { class: s.error_code ? '' : 'muted' },
                  s.error_code ? `${s.error_code} — ${s.error_message || 'sem descrição'}` : '—'),
                h('td', {}, String(s.attempts != null ? s.attempts : 0)),
                h('td', { class: 'muted' }, fmtDateTime(s.sent_at)),
              ]),
            ),
          ),
        ]),
      );
    }

    /** Filtro por status — é como o operador acha as falhas sem ler o banco. */
    function renderFilters() {
      filterBar.innerHTML = '';
      for (const f of ['todos', 'sent', 'failed', 'pending', 'sending']) {
        const label = f === 'todos' ? 'Todos' : (SEND_STATUS[f] || {}).label || f;
        filterBar.appendChild(
          h('button', {
            class: 'btn' + (filtro === f ? ' btn--primary' : ''),
            onclick: () => {
              filtro = f;
              renderFilters();
              renderSends();
            },
          }, label),
        );
      }
    }
    renderFilters();

    function startPolling() {
      stopDispatchPolling();
      dispatchTimer = setInterval(async () => {
        try {
          const t = await api.post(api.forInstance('/campaigns/' + campaignId + '/tick'));
          renderStatus(
            {
              status: t.status,
              total_recipients: t.sent + t.failed + t.pending,
              sent_count: t.sent,
              failed_count: t.failed,
            },
            t,
          );
          await renderSends();
          if (t.status !== 'running') {
            stopDispatchPolling();
            await loadCampaigns();
          }
        } catch (e) {
          stopDispatchPolling();
          alert('Erro no disparo: ' + e.message);
        }
      }, 2500);
    }

    controls.appendChild(
      h('button', {
        class: 'btn btn--primary',
        onclick: async () => {
          try {
            const started = await api.post(api.forInstance('/campaigns/' + campaignId + '/start'));
            renderStatus(started, null);
            await renderSends();
            await loadCampaigns();
            startPolling();
          } catch (e) {
            alert('Erro ao iniciar: ' + e.message);
          }
        },
      }, campaign.status === 'paused' ? 'Retomar disparo' : 'Iniciar disparo'),
    );
    controls.appendChild(
      h('button', {
        class: 'btn',
        onclick: async () => {
          stopDispatchPolling();
          try {
            await api.post(api.forInstance('/campaigns/' + campaignId + '/pause'));
          } catch (e) {
            alert('Erro ao pausar: ' + e.message);
          }
          await loadCampaigns();
          await openDetail(campaignId);
        },
      }, 'Pausar'),
    );
    controls.appendChild(
      h('button', { class: 'btn', onclick: () => renderSends() }, 'Atualizar'),
    );

    await renderSends();
    if (campaign.status === 'running') startPolling();
  }

  // ------------------------------------------------------------------ form
  async function renderForm() {
    formCard.innerHTML = '';
    formCard.appendChild(h('h3', { class: 'card__title' }, 'Nova campanha'));

    let templates = [];
    let lists = [];
    try {
      templates = await api.get(api.forInstance('/templates'));
      lists = await api.get(api.forInstance('/lists'));
    } catch (e) {
      formCard.appendChild(
        h('div', { class: 'placeholder placeholder--error' }, 'Erro ao carregar dados: ' + e.message),
      );
      return;
    }

    const field = (label, node, hint) =>
      h('div', { style: 'margin-bottom:12px' }, [
        h('div', { class: 'muted', style: 'margin-bottom:4px' }, label),
        node,
        hint ? h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, hint) : null,
      ]);

    const nameInput = h('input', { class: 'select', placeholder: 'Nome da campanha', style: 'width:100%' });
    const tplSelect = h(
      'select',
      { class: 'select', style: 'width:100%' },
      [h('option', { value: '' }, '— selecione um template —')].concat(
        templates.map((t) => h('option', { value: t.id }, `${t.name} (${t.language}) · ${t.status}`)),
      ),
    );
    // Intervalo é decisão do operador (PRD): nada de valor fixo escondido.
    const intervalInput = h('input', {
      class: 'select', type: 'number', min: '0', step: '100', value: '1000', style: 'width:100%',
    });
    const listChecks = lists.map((l) => {
      const cb = h('input', { type: 'checkbox', value: l.id });
      return { cb, node: h('label', { style: 'display:block;margin:3px 0' }, [cb, ' ' + l.name]) };
    });

    const tplInfo = h('div', {});
    const varsWrap = h('div', {});
    /** { key → input } das variáveis derivadas do template selecionado. */
    let varInputs = [];

    function renderVarsForTemplate() {
      tplInfo.innerHTML = '';
      varsWrap.innerHTML = '';
      varInputs = [];

      const tpl = templates.find((t) => t.id === tplSelect.value);
      if (!tpl) {
        varsWrap.appendChild(
          h('div', { class: 'muted' }, 'Selecione um template para ver as variáveis que ele espera.'),
        );
        return;
      }

      const body = templateBodyPreview(tpl);
      if (body) {
        tplInfo.appendChild(
          h('div', {
            class: 'muted',
            style: 'font-size:12px;white-space:pre-wrap;background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:10px;max-height:140px;overflow:auto',
          }, body),
        );
      }

      const slots = expectedTemplateVars(tpl);
      if (!slots.length) {
        varsWrap.appendChild(
          h('div', { class: 'muted' }, 'Este template não tem variáveis — nada a preencher.'),
        );
        return;
      }

      for (const slot of slots) {
        const input = h('input', {
          class: 'select',
          value: slot.suggested || '',
          placeholder: 'name, phone, crm.stage, lit:texto…',
          style: 'width:100%',
        });
        varInputs.push({ key: slot.key, input });
        varsWrap.appendChild(
          h('div', { style: 'margin-bottom:8px' }, [
            h('div', { style: 'font-weight:600;font-size:12px' }, slot.label),
            slot.hint
              ? h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:3px' },
                  'Exemplo da Meta: ' + slot.hint)
              : null,
            input,
          ]),
        );
      }
    }
    tplSelect.addEventListener('change', renderVarsForTemplate);
    renderVarsForTemplate();

    formCard.appendChild(field('Nome', nameInput));
    formCard.appendChild(
      field('Template', tplSelect, 'O idioma vem do template cadastrado na Meta — nunca é assumido.'),
    );
    formCard.appendChild(tplInfo);
    formCard.appendChild(
      field(
        'Listas alvo',
        lists.length
          ? h('div', {}, listChecks.map((c) => c.node))
          : h('div', { class: 'muted' }, 'Nenhuma lista criada ainda (vá em Listas).'),
      ),
    );
    formCard.appendChild(
      field(
        'Intervalo entre envios (ms)',
        intervalInput,
        'Espaçamento entre cada mensagem. Mais alto = mais devagar e mais seguro contra rate-limit da Meta.',
      ),
    );
    formCard.appendChild(
      field(
        'Variáveis do template → origem do valor',
        h('div', {}, [varsWrap]),
        'Origens: name, phone, crm.stage, crm.score, crm.custom_fields.<chave> ou lit:<texto fixo>.',
      ),
    );

    formCard.appendChild(
      h('button', {
        class: 'btn btn--primary',
        onclick: async () => {
          const name = nameInput.value.trim();
          if (!name) return alert('Informe o nome da campanha.');
          const list_ids = listChecks.filter((c) => c.cb.checked).map((c) => c.cb.value);
          if (!list_ids.length) return alert('Escolha ao menos uma lista alvo.');

          const variables = {};
          for (const v of varInputs) {
            const val = v.input.value.trim();
            if (val) variables[v.key] = val;
          }
          const faltando = varInputs.filter((v) => !v.input.value.trim());
          if (faltando.length &&
              !confirm(
                `${faltando.length} variável(is) sem origem definida. ` +
                'A Meta pode rejeitar o envio por contagem de parâmetros. Criar mesmo assim?',
              )) {
            return;
          }

          try {
            const created = await api.post(api.forInstance('/campaigns'), {
              name,
              template_id: tplSelect.value || null,
              list_ids,
              variables,
              interval_ms: Number(intervalInput.value) || 0,
            });
            nameInput.value = '';
            listChecks.forEach((c) => (c.cb.checked = false));
            await loadCampaigns();
            await openDetail(created.id);
          } catch (e) {
            alert('Erro ao criar: ' + e.message);
          }
        },
      }, 'Criar campanha'),
    );
  }

  renderForm();
  loadCampaigns();
  renderEmptyDetail();
  return root;
}

// ----------------------------------------------------- Builder de fluxos (P4.5)
/** Área do canvas em coordenadas do GRAFO (o zoom multiplica só na exibição). */
const CANVAS_W = 2400;
const CANVAS_H = 1600;

const NODE_META = {
  start: { label: '▶ Início', data: () => ({}) },
  message: { label: '💬 Mensagem', data: () => ({ text: 'Olá {{nome}}!' }) },
  media: { label: '🖼 Mídia', data: () => ({ kind: 'image', url: '', caption: '' }) },
  buttons: {
    label: '🔘 Botões',
    data: () => ({ text: 'Escolha:', buttons: [{ id: 'b1', title: 'Opção 1' }] }),
  },
  list: {
    label: '📋 Lista',
    data: () => ({ text: 'Escolha:', buttonText: 'Ver opções', sections: [{ title: '', rows: [{ id: 'r1', title: 'Item 1' }] }] }),
  },
  delay: { label: '⏱ Aguardar', data: () => ({ seconds: 5 }) },
  tag: { label: '🏷 Tag', data: () => ({ name: '' }) },
  randomizer: { label: '🎲 Randomizador', data: () => ({ mode: 'round_robin', outputs: 2 }) },
  condition: { label: '🔀 Condição', data: () => ({ rules: [{ handle: 'r1', kind: 'text_contains', value: '' }] }) },
  wait_input: { label: '⌨ Aguardar Resposta', data: () => ({ variable: 'resposta', timeoutSeconds: 0 }) },
  webhook: { label: '🌐 Webhook', data: () => ({ url: '', method: 'GET', saveTo: '' }) },
  end: { label: '⏹ Fim', data: () => ({}) },
};

function nodeOutputs(node) {
  const d = node.data || {};
  switch (node.type) {
    case 'end':
      return [];
    case 'buttons':
      return (d.buttons || []).map((b) => ({ handle: b.id, label: b.title }));
    case 'list':
      return ((d.sections || [])[0]?.rows || []).map((r) => ({ handle: r.id, label: r.title }));
    case 'wait_input':
      return [
        { handle: 'reply', label: 'resposta' },
        { handle: 'timeout', label: 'sem resposta' },
      ];
    case 'randomizer':
      return Array.from({ length: Number(d.outputs) || 2 }, (_, i) => ({
        handle: String(i),
        label: 'caminho ' + (i + 1),
      }));
    case 'condition':
      return (d.rules || [])
        .map((r) => ({ handle: r.handle, label: r.kind + ' "' + r.value + '"' }))
        .concat([{ handle: 'else', label: 'senão' }]);
    default:
      return [{ handle: null, label: 'seguir' }];
  }
}

function nodeSummary(node) {
  const d = node.data || {};
  switch (node.type) {
    case 'message': return d.text || '';
    case 'media': return (d.kind || '') + ' ' + (d.url || '');
    case 'buttons': return d.text || '';
    case 'list': return d.text || '';
    case 'delay': return 'esperar ' + (Number(d.seconds) || 0) + 's';
    case 'tag': return d.name || '(sem tag)';
    case 'randomizer': return d.mode === 'round_robin' ? 'round-robin' : 'aleatório';
    case 'wait_input': return '→ {{' + (d.variable || 'resposta') + '}}';
    case 'webhook': return (d.method || 'GET') + ' ' + (d.url || '');
    case 'condition': return (d.rules || []).length + ' regra(s)';
    default: return '';
  }
}

// Validação local (espelha /domain/flowValidation — avisar ANTES de salvar).
function validateFlowLocal(nodes, edges) {
  const warnings = [];
  const ids = new Set(nodes.map((n) => n.id));
  const starts = nodes.filter((n) => n.type === 'start');
  if (!starts.length) warnings.push('Fluxo sem nó Início — nunca será disparado.');
  for (const e of edges) {
    if (!ids.has(e.source)) warnings.push('Aresta solta: origem "' + e.source + '" não existe.');
    if (!ids.has(e.target)) warnings.push('Aresta solta: destino "' + e.target + '" não existe.');
  }
  if (starts.length) {
    const adj = {};
    for (const e of edges) (adj[e.source] = adj[e.source] || []).push(e.target);
    const seen = new Set();
    const stack = starts.map((s) => s.id);
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const nx of adj[cur] || []) stack.push(nx);
    }
    for (const n of nodes) {
      if (!seen.has(n.id)) warnings.push('Nó órfão: "' + n.id + '" (' + n.type + ') inalcançável.');
    }
  }
  return warnings;
}

function chatbotScreen() {
  const listPanel = h('div', { class: 'card builder__panel' });
  const canvasWrap = h('div', { class: 'canvas-wrap' });
  const editorPanel = h('div', { class: 'card builder__panel' });
  const warningsEl = h('div', {});
  // screen--full-3: cabeçalho + avisos + canvas (o canvas é a linha 1fr).
  const root = h('div', { class: 'screen--full screen--full-3' }, [
    pageHeader('Chatbot', 'Construtor visual de fluxos.'),
    warningsEl,
    h('div', { class: 'builder' }, [listPanel, canvasWrap, editorPanel]),
  ]);

  // Fluxo em edição (cópia de trabalho).
  let current = null; // { id?, name, trigger_keywords, active, nodes, edges }
  let selectedId = null;
  let pendingConnect = null; // { source, handle }
  let nextNum = 1;
  /** Tags da instância, para o nó Tag escolher em vez de digitar (P1.5). */
  let tags = [];
  /** Zoom do canvas. Pan é o scroll do container (arrastar o fundo). */
  const view = { scale: 1 };

  function setZoom(next) {
    const antes = view.scale;
    view.scale = Math.min(1.6, Math.max(0.4, Number(next.toFixed(2))));
    if (view.scale === antes) return;
    // Mantém o centro visível ancorado ao ampliar/reduzir.
    const k = view.scale / antes;
    const cx = canvasWrap.scrollLeft + canvasWrap.clientWidth / 2;
    const cy = canvasWrap.scrollTop + canvasWrap.clientHeight / 2;
    renderCanvas();
    canvasWrap.scrollLeft = cx * k - canvasWrap.clientWidth / 2;
    canvasWrap.scrollTop = cy * k - canvasWrap.clientHeight / 2;
  }

  function zoomControls() {
    return h('div', { class: 'canvas-zoom' }, [
      h('button', { title: 'Reduzir', onclick: () => setZoom(view.scale - 0.2) }, '−'),
      h('span', {}, Math.round(view.scale * 100) + '%'),
      h('button', { title: 'Ampliar', onclick: () => setZoom(view.scale + 0.2) }, '+'),
      h('button', { title: 'Voltar a 100%', onclick: () => setZoom(1) }, '⤢'),
    ]);
  }

  function newId() {
    // Ids únicos e ESTÁVEIS: nunca reaproveitar (lição 4 — recriar muda o id).
    return 'n' + Date.now().toString(36) + '_' + nextNum++;
  }

  function setWarnings(list, extra) {
    warningsEl.innerHTML = '';
    const items = [].concat(list || []);
    if (extra) items.unshift(extra);
    if (!items.length) return;
    warningsEl.appendChild(
      h('div', { class: 'builder-warnings' }, [
        h('strong', {}, '⚠ Avisos: '),
        h('ul', { style: 'margin:6px 0 0 18px;padding:0' }, items.map((w) => h('li', {}, w))),
      ]),
    );
  }

  // ---------------------------------------------------------------- lista
  async function loadFlows() {
    const flows = await api.get(api.forInstance('/flows')).catch(() => []);
    listPanel.innerHTML = '';
    listPanel.appendChild(h('h3', { class: 'card__title' }, 'Fluxos'));
    listPanel.appendChild(
      h('button', {
        class: 'btn btn--primary',
        style: 'width:100%;margin-bottom:10px',
        onclick: () => {
          const startId = newId();
          current = {
            name: 'Novo fluxo',
            trigger_keywords: [],
            active: false,
            nodes: [{ id: startId, type: 'start', data: {}, x: 40, y: 60 }],
            edges: [],
          };
          selectedId = startId;
          renderAll();
        },
      }, '+ Novo fluxo'),
    );
    for (const f of flows) {
      listPanel.appendChild(
        h('div', {
          class: 'conv-item',
          onclick: async () => {
            const full = await api.get(api.forInstance('/flows/' + f.id));
            current = {
              id: full.id,
              name: full.name,
              trigger_keywords: full.trigger_keywords || [],
              active: full.active,
              nodes: full.nodes || [],
              edges: full.edges || [],
            };
            selectedId = null;
            pendingConnect = null;
            renderAll();
            // LIÇÃO 4: avisa sobre execuções ativas ao abrir p/ edição.
            const act = await api
              .get(api.forInstance('/flows/' + f.id + '/executions/active'))
              .catch(() => null);
            if (act && act.total > 0) {
              setWarnings([], `Este fluxo tem ${act.total} execução(ões) ATIVA(s). ` +
                'Prefira editar o conteúdo dos nós a apagar+recriar (apagar muda o id e ' +
                'derruba execuções paradas nele).');
            }
          },
        }, [
          h('div', { class: 'conv-item__top' }, [
            h('span', { class: 'conv-item__name' }, f.name),
            h('span', { class: 'badge ' + (f.active ? 'badge--ok' : '') }, f.active ? 'ativo' : 'rascunho'),
          ]),
          h('div', { class: 'conv-item__preview' }, (f.trigger_keywords || []).join(', ') || 'sem gatilho'),
        ]),
      );
    }
  }

  // ---------------------------------------------------------------- canvas
  function portPos(node, handleIndex) {
    return { x: node.x + 190, y: node.y + 28 + 24 + handleIndex * 22 + 11 };
  }
  function inputPos(node) {
    return { x: node.x, y: node.y + 18 };
  }

  function renderCanvas() {
    canvasWrap.innerHTML = '';
    if (!current) {
      canvasWrap.appendChild(h('div', { class: 'placeholder' }, 'Selecione ou crie um fluxo.'));
      return;
    }
    // Sizer + palco: o palco recebe o transform do zoom; o sizer carrega a
    // área rolável já escalada, senão as barras de rolagem descolam do
    // conteúdo assim que o zoom sai de 100%.
    const inner = h('div', {
      class: 'canvas-inner',
      style: `width:${CANVAS_W * view.scale}px;height:${CANVAS_H * view.scale}px`,
    });
    const stage = h('div', {
      class: 'canvas-stage',
      style: `transform:scale(${view.scale})`,
    });
    inner.appendChild(stage);
    canvasWrap.appendChild(inner);
    canvasWrap.appendChild(zoomControls());

    // Arrastar o FUNDO move a tela (pan). Só no fundo: em cima do nó, o
    // pointerdown do cabeçalho é que manda.
    inner.addEventListener('pointerdown', (ev) => {
      if (ev.target !== inner && ev.target !== stage) return;
      ev.preventDefault();
      const sx = ev.clientX;
      const sy = ev.clientY;
      const l0 = canvasWrap.scrollLeft;
      const t0 = canvasWrap.scrollTop;
      canvasWrap.classList.add('panning');
      const move = (mv) => {
        canvasWrap.scrollLeft = l0 - (mv.clientX - sx);
        canvasWrap.scrollTop = t0 - (mv.clientY - sy);
      };
      const up = () => {
        canvasWrap.classList.remove('panning');
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });

    // Arestas (SVG por baixo dos nós).
    const svgEl = svg('svg', { class: 'edges' });
    stage.appendChild(svgEl);
    const byId = Object.fromEntries(current.nodes.map((n) => [n.id, n]));
    for (const e of current.edges) {
      const s = byId[e.source];
      const t = byId[e.target];
      if (!s || !t) continue;
      const outs = nodeOutputs(s);
      const idx = Math.max(0, outs.findIndex((o) => (o.handle || null) === (e.sourceHandle || null)));
      const p1 = portPos(s, idx);
      const p2 = inputPos(t);
      const dx = Math.max(40, Math.abs(p2.x - p1.x) / 2);
      svgEl.appendChild(
        svg('path', {
          d: `M${p1.x},${p1.y} C${p1.x + dx},${p1.y} ${p2.x - dx},${p2.y} ${p2.x},${p2.y}`,
          fill: 'none',
          stroke: '#1da851',
          'stroke-width': 2,
          opacity: 0.75,
        }),
      );
    }

    // Nós.
    for (const node of current.nodes) {
      const meta = NODE_META[node.type] || { label: node.type };
      const outs = nodeOutputs(node);
      const el = h('div', {
        class: 'fnode' + (node.id === selectedId ? ' selected' : ''),
        style: `left:${node.x}px;top:${node.y}px`,
      }, [
        h('div', { class: 'fnode__head' }, [meta.label]),
        h('div', { class: 'fnode__body' }, nodeSummary(node)),
        ...outs.map((o) => {
          const port = h('span', {
            class: 'port' +
              (pendingConnect && pendingConnect.source === node.id &&
               (pendingConnect.handle || null) === (o.handle || null) ? ' pending' : ''),
          });
          port.addEventListener('click', (ev) => {
            ev.stopPropagation();
            pendingConnect = { source: node.id, handle: o.handle };
            renderCanvas();
          });
          return h('div', { class: 'fnode__out' }, [o.label, port]);
        }),
      ]);

      // Porta de ENTRADA (destino de conexão pendente).
      if (node.type !== 'start') {
        const inPort = h('span', { class: 'port port--in' });
        inPort.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (!pendingConnect || pendingConnect.source === node.id) return;
          // Uma aresta por saída: substitui a existente da mesma saída.
          current.edges = current.edges.filter(
            (e) => !(e.source === pendingConnect.source &&
                     (e.sourceHandle || null) === (pendingConnect.handle || null)),
          );
          const edge = { source: pendingConnect.source, target: node.id };
          if (pendingConnect.handle != null) edge.sourceHandle = pendingConnect.handle;
          current.edges.push(edge);
          pendingConnect = null;
          renderCanvas();
        });
        el.appendChild(inPort);
      }

      // Seleção + drag pelo cabeçalho.
      el.addEventListener('click', () => {
        selectedId = node.id;
        renderEditor();
        renderCanvas();
      });
      const head = el.querySelector('.fnode__head');
      head.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        const startX = ev.clientX;
        const startY = ev.clientY;
        const origX = node.x;
        const origY = node.y;
        function move(mv) {
          // Divide pela escala: com zoom em 50%, 100px de mouse são 200px de
          // canvas — sem isto o nó "foge" do cursor fora do zoom 100%.
          node.x = Math.max(0, origX + (mv.clientX - startX) / view.scale);
          node.y = Math.max(0, origY + (mv.clientY - startY) / view.scale);
          renderCanvas();
        }
        function up() {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', up);
        }
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
      });

      stage.appendChild(el);
    }
  }

  // ---------------------------------------------------------------- editor
  function field(label, input) {
    return h('div', { class: 'field' }, [h('label', {}, label), input]);
  }
  function boundInput(obj, key, attrs = {}, tag = 'input') {
    const el = h(tag, { ...attrs, value: obj[key] != null ? String(obj[key]) : '' });
    if (tag === 'textarea') el.value = obj[key] || '';
    el.addEventListener('input', () => {
      obj[key] = attrs.type === 'number' ? Number(el.value) : el.value;
      renderCanvas();
    });
    return el;
  }

  function nodeEditor(node) {
    const d = node.data;
    const parts = [];
    switch (node.type) {
      case 'message':
        parts.push(field('Texto ({{variáveis}} ok)', boundInput(d, 'text', { rows: '4' }, 'textarea')));
        break;
      case 'media': {
        const sel = h('select', {}, ['image', 'video', 'audio', 'document'].map((k) =>
          h('option', { value: k, ...(d.kind === k ? { selected: 'selected' } : {}) }, k)));
        sel.addEventListener('change', () => { d.kind = sel.value; renderCanvas(); });
        parts.push(field('Tipo', sel));
        parts.push(field('URL', boundInput(d, 'url')));
        parts.push(field('Legenda', boundInput(d, 'caption')));
        break;
      }
      case 'buttons': {
        parts.push(field('Texto', boundInput(d, 'text', { rows: '2' }, 'textarea')));
        (d.buttons || []).forEach((b, i) => {
          parts.push(field('Botão ' + (i + 1) + ' (id: ' + b.id + ')', boundInput(b, 'title')));
        });
        if ((d.buttons || []).length < 3) {
          parts.push(h('button', {
            class: 'btn',
            onclick: () => {
              d.buttons.push({ id: 'b' + (d.buttons.length + 1) + '_' + newId(), title: 'Opção' });
              renderEditor(); renderCanvas();
            },
          }, '+ botão'));
        }
        break;
      }
      case 'list': {
        parts.push(field('Texto', boundInput(d, 'text', { rows: '2' }, 'textarea')));
        parts.push(field('Texto do botão', boundInput(d, 'buttonText')));
        const rows = d.sections[0].rows;
        rows.forEach((r, i) => {
          parts.push(field('Opção ' + (i + 1) + ' (id: ' + r.id + ')', boundInput(r, 'title')));
        });
        if (rows.length < 10) {
          parts.push(h('button', {
            class: 'btn',
            onclick: () => {
              rows.push({ id: 'r' + (rows.length + 1) + '_' + newId(), title: 'Item' });
              renderEditor(); renderCanvas();
            },
          }, '+ opção'));
        }
        break;
      }
      case 'delay':
        // Só a duração. Se o delay dorme inline ou persiste e retoma é
        // IMPLEMENTAÇÃO do motor — virar campo/rótulo de UI só confundiria
        // quem monta o fluxo, sem nenhuma decisão a tomar a respeito.
        parts.push(field('Segundos de espera', boundInput(d, 'seconds', { type: 'number', min: '0' })));
        break;
      case 'tag': {
        // Escolhe entre as tags que existem (P1.5) em vez de digitar o nome:
        // um typo aqui viraria tag nova e silenciosa no meio do fluxo.
        const atual = d.name || '';
        const conhecidas = tags.map((t) => t.name);
        const opts = conhecidas.map((n) =>
          h('option', { value: n, ...(n === atual ? { selected: 'selected' } : {}) }, n));
        if (!conhecidas.length) {
          parts.push(field('Tag', h('div', { class: 'muted' },
            'Nenhuma tag criada ainda — crie em Contatos.')));
          break;
        }
        // Fluxo salvo com tag que foi apagada depois: mantém a opção visível e
        // MARCADA, em vez de trocar em silêncio pela primeira da lista.
        if (atual && !conhecidas.includes(atual)) {
          opts.unshift(h('option', { value: atual, selected: 'selected' }, atual + ' (não existe mais)'));
        }
        if (!atual) opts.unshift(h('option', { value: '', selected: 'selected' }, '— escolha a tag —'));
        const sel = h('select', {}, opts);
        sel.addEventListener('change', () => { d.name = sel.value; renderCanvas(); });
        parts.push(field('Aplicar a tag', sel));
        break;
      }
      case 'randomizer': {
        const sel = h('select', {}, [
          h('option', { value: 'round_robin', ...(d.mode === 'round_robin' ? { selected: 'selected' } : {}) }, 'round-robin (equilibrado)'),
          h('option', { value: 'random', ...(d.mode === 'random' ? { selected: 'selected' } : {}) }, 'aleatório'),
        ]);
        sel.addEventListener('change', () => { d.mode = sel.value; renderCanvas(); });
        parts.push(field('Modo', sel));
        parts.push(field('Nº de caminhos', boundInput(d, 'outputs', { type: 'number' })));
        break;
      }
      case 'condition': {
        (d.rules || []).forEach((r, i) => {
          const kindSel = h('select', {}, ['text_contains', 'variable_contains', 'has_tag'].map((k) =>
            h('option', { value: k, ...(r.kind === k ? { selected: 'selected' } : {}) }, k)));
          kindSel.addEventListener('change', () => { r.kind = kindSel.value; renderEditor(); renderCanvas(); });
          parts.push(field('Regra ' + (i + 1) + ' — tipo', kindSel));
          if (r.kind === 'variable_contains') {
            parts.push(field('Variável', boundInput(r, 'variable')));
          }
          parts.push(field('Valor', boundInput(r, 'value')));
        });
        parts.push(h('button', {
          class: 'btn',
          onclick: () => {
            d.rules.push({ handle: 'r' + (d.rules.length + 1) + '_' + newId(), kind: 'text_contains', value: '' });
            renderEditor(); renderCanvas();
          },
        }, '+ regra'));
        break;
      }
      case 'wait_input':
        parts.push(field('Salvar resposta na variável', boundInput(d, 'variable')));
        parts.push(field('Timeout em segundos (0 = sem timeout)', boundInput(d, 'timeoutSeconds', { type: 'number' })));
        break;
      case 'webhook': {
        parts.push(field('URL', boundInput(d, 'url')));
        const sel = h('select', {}, ['GET', 'POST'].map((mth) =>
          h('option', { value: mth, ...(d.method === mth ? { selected: 'selected' } : {}) }, mth)));
        sel.addEventListener('change', () => { d.method = sel.value; renderCanvas(); });
        parts.push(field('Método', sel));
        parts.push(field('Salvar resposta na variável', boundInput(d, 'saveTo')));
        break;
      }
      default:
        parts.push(h('div', { class: 'muted' }, 'Este nó não tem configurações.'));
    }
    return parts;
  }

  async function renderEditor() {
    editorPanel.innerHTML = '';
    if (!current) return;

    editorPanel.appendChild(h('h3', { class: 'card__title' }, 'Fluxo'));
    const nameIn = boundInput(current, 'name');
    editorPanel.appendChild(field('Nome', nameIn));
    const kwIn = h('input', { value: (current.trigger_keywords || []).join(', ') });
    kwIn.addEventListener('input', () => {
      current.trigger_keywords = kwIn.value.split(',').map((s) => s.trim()).filter(Boolean);
    });
    editorPanel.appendChild(field('Palavras-gatilho (vírgula)', kwIn));
    const activeCb = h('input', { type: 'checkbox', ...(current.active ? { checked: 'checked' } : {}) });
    activeCb.addEventListener('change', () => { current.active = activeCb.checked; });
    editorPanel.appendChild(h('div', { class: 'field' }, [h('label', {}, [activeCb, ' Fluxo ativo'])]));

    // Paleta de nós.
    editorPanel.appendChild(h('h3', { class: 'card__title' }, 'Adicionar nó'));
    const palette = h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px' });
    for (const [type, meta] of Object.entries(NODE_META)) {
      if (type === 'start' && current.nodes.some((n) => n.type === 'start')) continue;
      palette.appendChild(h('button', {
        class: 'btn',
        style: 'font-size:11px;padding:4px 8px',
        onclick: () => {
          const n = { id: newId(), type, data: meta.data(), x: 80 + Math.random() * 200, y: 80 + Math.random() * 200 };
          current.nodes.push(n);
          selectedId = n.id;
          renderEditor();
          renderCanvas();
        },
      }, meta.label));
    }
    editorPanel.appendChild(palette);

    // Editor do nó selecionado.
    const node = current.nodes.find((n) => n.id === selectedId);
    if (node) {
      editorPanel.appendChild(h('h3', { class: 'card__title' }, 'Nó: ' + (NODE_META[node.type]?.label || node.type)));
      for (const p of nodeEditor(node)) editorPanel.appendChild(p);

      // Arestas saindo do nó (remoção explícita).
      const myEdges = current.edges.filter((e) => e.source === node.id || e.target === node.id);
      if (myEdges.length) {
        editorPanel.appendChild(h('h3', { class: 'card__title' }, 'Conexões'));
        for (const e of myEdges) {
          editorPanel.appendChild(h('div', { class: 'field', style: 'display:flex;gap:6px;align-items:center' }, [
            h('span', { class: 'muted', style: 'flex:1;font-size:11px' },
              e.source + (e.sourceHandle ? '[' + e.sourceHandle + ']' : '') + ' → ' + e.target),
            h('button', {
              class: 'btn', style: 'padding:2px 8px',
              onclick: () => {
                current.edges = current.edges.filter((x) => x !== e);
                renderEditor(); renderCanvas();
              },
            }, '✕'),
          ]));
        }
      }

      // Excluir nó — PROTEÇÃO DA LIÇÃO 4.
      if (node.type !== 'start') {
        editorPanel.appendChild(h('button', {
          class: 'btn',
          style: 'margin-top:8px;color:#991b1b',
          onclick: async () => {
            let extra = '';
            if (current.id) {
              const act = await api
                .get(api.forInstance('/flows/' + current.id + '/executions/active'))
                .catch(() => null);
              const here = act && act.by_node ? (act.by_node[node.id] || 0) : 0;
              if (act && act.total > 0) {
                extra = `\n\nATENÇÃO: ${act.total} execução(ões) ativa(s) neste fluxo` +
                  (here ? `, ${here} parada(s) NESTE nó` : '') +
                  '. Apagar o nó muda o id e essas execuções serão canceladas COM aviso ' +
                  'na retomada. Prefira EDITAR o conteúdo do nó.';
              }
            }
            if (!confirm('Apagar o nó "' + node.id + '"? Prefira editar o conteúdo — apagar+recriar muda o id.' + extra)) return;
            current.nodes = current.nodes.filter((n) => n.id !== node.id);
            current.edges = current.edges.filter((e) => e.source !== node.id && e.target !== node.id);
            selectedId = null;
            renderEditor(); renderCanvas();
          },
        }, 'Excluir nó'));
      }
    } else {
      editorPanel.appendChild(h('div', { class: 'muted' }, 'Clique num nó para editar. Para conectar: clique na bolinha de uma saída e depois na bolinha de entrada (esquerda) do nó destino.'));
    }

    // Salvar.
    editorPanel.appendChild(h('button', {
      class: 'btn btn--primary',
      style: 'width:100%;margin-top:12px',
      onclick: async () => {
        const warnings = validateFlowLocal(current.nodes, current.edges);
        if (warnings.length) {
          setWarnings(warnings);
          if (!confirm('O fluxo tem avisos:\n\n- ' + warnings.join('\n- ') + '\n\nSalvar mesmo assim?')) return;
        } else {
          setWarnings([]);
        }
        const payload = {
          name: current.name,
          trigger_keywords: current.trigger_keywords,
          nodes: current.nodes,
          edges: current.edges,
          active: current.active,
        };
        try {
          const res = current.id
            ? await api.raw('PATCH', api.forInstance('/flows/' + current.id), payload)
            : await api.post(api.forInstance('/flows'), payload);
          current.id = res.flow.id;
          setWarnings(res.warnings || []);
          loadFlows();
          alert('Fluxo salvo.');
        } catch (e) {
          alert('Erro ao salvar: ' + e.message);
        }
      },
    }, 'Salvar fluxo'));
  }

  function renderAll() {
    setWarnings([]);
    renderCanvas();
    renderEditor();
  }

  // Tags carregadas uma vez: o nó Tag escolhe entre elas em vez de digitar.
  api
    .get(api.forInstance('/tags'))
    .then((t) => {
      tags = t;
      if (current) renderEditor();
    })
    .catch(() => {
      // Falha de carga não pode passar por "não há tags": o nó Tag cairia num
      // select vazio e o operador acharia que precisa criar tag de novo.
      setWarnings(['Não foi possível carregar as tags — o nó Tag pode aparecer vazio.']);
    });

  loadFlows();
  renderAll();
  return root;
}

// ------------------------------------------------------------- Contatos (P1.5)
/**
 * Contatos + Tags numa tela só: listar/buscar, corrigir nome (plano B do PRD
 * quando a Meta não manda profile.name), e criar/aplicar/remover tags —
 * inclusive EM MASSA sobre os contatos selecionados.
 */
function contatosScreen() {
  const listCard = h('div', { class: 'card' });
  const sideCard = h('div', { class: 'card' });
  const root = h('div', {}, [
    pageHeader('Contatos', 'Contatos da instância, nomes e tags. O nome vem do WhatsApp — quando a Meta não compartilha, você corrige aqui.'),
    h('div', { class: 'dash-grid' }, [listCard, sideCard]),
  ]);

  let contacts = [];
  let tags = [];
  let tagsByContact = {};
  let selectedIds = new Set();
  let detailId = null;
  let term = '';

  async function loadAll() {
    try {
      // Três chamadas, não uma por contato: as tags vêm agrupadas do servidor.
      const [c, t, byContact] = await Promise.all([
        api.get(api.forInstance('/contacts')),
        api.get(api.forInstance('/tags')),
        api.get(api.forInstance('/tags/by-contact')),
      ]);
      contacts = c;
      tags = t;
      tagsByContact = byContact;
    } catch (e) {
      listCard.innerHTML = '';
      listCard.appendChild(
        h('div', { class: 'placeholder placeholder--error' }, 'Erro ao carregar contatos: ' + e.message),
      );
      return false;
    }
    // Selecionados que sumiram (ex.: filtro/recarga) não podem virar fantasma.
    selectedIds = new Set([...selectedIds].filter((id) => contacts.some((c) => c.id === id)));
    return true;
  }

  function visibleContacts() {
    const q = term.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) => (c.name || '').toLowerCase().includes(q) || c.phone.includes(q),
    );
  }

  function tagChip(tag, onRemove) {
    return h('span', {
      class: 'badge',
      style: 'margin-right:4px' + (tag.color ? `;background:${tag.color}22;color:${tag.color}` : ''),
    }, onRemove ? [tag.name + ' ', h('a', { href: '#', style: 'text-decoration:none', onclick: onRemove }, '×')] : tag.name);
  }

  // ------------------------------------------------------------------ lista
  function renderList() {
    listCard.innerHTML = '';
    listCard.appendChild(h('h3', { class: 'card__title' }, `Contatos (${contacts.length})`));

    const search = h('input', {
      class: 'select', placeholder: 'Buscar por nome ou telefone…',
      style: 'width:100%;margin-bottom:10px', value: term,
    });
    search.addEventListener('input', () => {
      term = search.value;
      drawRows();
      // Mantém o foco: redesenhar a tabela não pode roubar o cursor da busca.
      const pos = search.selectionStart;
      search.focus();
      search.setSelectionRange(pos, pos);
    });
    listCard.appendChild(search);

    // Barra de ação em massa — só aparece com algo selecionado.
    const bulkBar = h('div', { style: 'margin-bottom:10px' });
    listCard.appendChild(bulkBar);

    const tableWrap = h('div', { style: 'max-height:460px;overflow:auto' });
    listCard.appendChild(tableWrap);

    function renderBulk() {
      bulkBar.innerHTML = '';
      if (!selectedIds.size) return;
      const tagSel = h('select', { class: 'select' },
        [h('option', { value: '' }, '— escolha a tag —')].concat(
          tags.map((t) => h('option', { value: t.id }, t.name)),
        ));
      const run = async (acao) => {
        if (!tagSel.value) return alert('Escolha a tag.');
        try {
          await api.post(api.forInstance(`/tags/${tagSel.value}/${acao}`), {
            contactIds: [...selectedIds],
          });
          await loadAll();
          renderList();
          renderSide();
        } catch (e) {
          alert('Erro: ' + e.message);
        }
      };
      bulkBar.appendChild(
        h('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:8px' }, [
          h('span', { class: 'muted', style: 'font-size:12px' }, `${selectedIds.size} selecionado(s)`),
          tagSel,
          h('button', { class: 'btn btn--primary', onclick: () => run('apply') }, 'Aplicar tag'),
          h('button', { class: 'btn', onclick: () => run('remove') }, 'Remover tag'),
          h('button', {
            class: 'btn',
            onclick: () => { selectedIds = new Set(); renderList(); },
          }, 'Limpar seleção'),
        ]),
      );
    }

    function drawRows() {
      const rows = visibleContacts();
      tableWrap.innerHTML = '';
      if (!rows.length) {
        tableWrap.appendChild(
          h('div', { class: 'muted', style: 'padding:12px' },
            contacts.length ? 'Nenhum contato bate com a busca.' : 'Nenhum contato ainda — eles aparecem quando alguém manda mensagem.'),
        );
        return;
      }
      const master = h('input', {
        type: 'checkbox',
        onchange: (ev) => {
          for (const c of rows) {
            if (ev.target.checked) selectedIds.add(c.id);
            else selectedIds.delete(c.id);
          }
          renderList();
        },
      });
      master.checked = rows.length > 0 && rows.every((c) => selectedIds.has(c.id));

      tableWrap.appendChild(
        h('table', { class: 'table' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { style: 'width:28px' }, [master]),
            h('th', {}, 'Contato'),
            h('th', {}, 'Tags'),
          ])]),
          h('tbody', {}, rows.map((c) => {
            const cb = h('input', {
              type: 'checkbox',
              onclick: (ev) => ev.stopPropagation(),
              onchange: (ev) => {
                if (ev.target.checked) selectedIds.add(c.id);
                else selectedIds.delete(c.id);
                renderBulk();
              },
            });
            cb.checked = selectedIds.has(c.id);
            const semNome = !c.name;
            return h('tr', {
              style: 'cursor:pointer' + (detailId === c.id ? ';background:#f8fafc' : ''),
              onclick: () => { detailId = c.id; renderSide(); },
            }, [
              h('td', {}, [cb]),
              h('td', {}, [
                h('div', {}, [
                  semNome
                    ? h('span', { class: 'muted', style: 'font-style:italic' }, 'sem nome')
                    : h('span', {}, c.name),
                  c.name_source === 'manual'
                    ? h('span', { class: 'muted', style: 'font-size:11px' }, ' (manual)')
                    : null,
                ]),
                h('div', { class: 'muted', style: 'font-size:11px' }, c.phone),
              ]),
              h('td', {}, (tagsByContact[c.id] || []).map((t) => tagChip(t))),
            ]);
          })),
        ]),
      );
      renderBulk();
    }
    drawRows();
  }

  // ------------------------------------------------- painel lateral (detalhe)
  function renderSide() {
    sideCard.innerHTML = '';
    const contact = contacts.find((c) => c.id === detailId);

    // Gestão das tags da instância vive sempre visível no topo do painel.
    sideCard.appendChild(h('h3', { class: 'card__title' }, 'Tags da instância'));
    const novaTag = h('input', { class: 'select', placeholder: 'Nome da nova tag', style: 'flex:1' });
    const novaCor = h('input', { type: 'color', value: '#25d366', style: 'width:40px;height:34px;padding:2px' });
    sideCard.appendChild(
      h('div', { style: 'display:flex;gap:6px;margin-bottom:8px' }, [
        novaTag, novaCor,
        h('button', {
          class: 'btn btn--primary',
          onclick: async () => {
            const nome = novaTag.value.trim();
            if (!nome) return alert('Informe o nome da tag.');
            try {
              await api.post(api.forInstance('/tags'), { name: nome, color: novaCor.value });
              novaTag.value = '';
              await loadAll();
              renderList();
              renderSide();
            } catch (e) {
              alert('Erro ao criar tag: ' + e.message);
            }
          },
        }, 'Criar'),
      ]),
    );
    sideCard.appendChild(
      tags.length
        ? h('div', { style: 'margin-bottom:14px' }, tags.map((t) =>
            h('span', { style: 'display:inline-block;margin:0 6px 6px 0' }, [
              tagChip(t, async (ev) => {
                ev.preventDefault();
                if (!confirm(`Excluir a tag "${t.name}"? Ela sai de todos os contatos.`)) return;
                try {
                  await api.del(api.forInstance('/tags/' + t.id));
                  await loadAll();
                  renderList();
                  renderSide();
                } catch (e) {
                  alert('Erro ao excluir tag: ' + e.message);
                }
              }),
            ]),
          ))
        : h('div', { class: 'muted', style: 'margin-bottom:14px' }, 'Nenhuma tag criada ainda.'),
    );

    if (!contact) {
      sideCard.appendChild(h('div', { class: 'muted' }, 'Selecione um contato para editar o nome e as tags dele.'));
      return;
    }

    sideCard.appendChild(h('h3', { class: 'card__title' }, 'Contato'));
    sideCard.appendChild(h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:6px' }, contact.phone));

    const nomeInput = h('input', {
      class: 'select', style: 'width:100%', placeholder: 'Nome do contato',
      value: contact.name || '',
    });
    const nomeMsg = h('div', { class: 'muted', style: 'font-size:12px;min-height:16px;margin:4px 0 8px' },
      contact.name_source === 'manual'
        ? 'Nome definido por você — o WhatsApp não sobrescreve mais.'
        : 'Nome vindo do WhatsApp. Se editar, sua versão passa a valer.');

    sideCard.appendChild(h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:4px' }, 'Nome'));
    sideCard.appendChild(nomeInput);
    sideCard.appendChild(nomeMsg);
    sideCard.appendChild(
      h('div', { style: 'display:flex;gap:6px;margin-bottom:14px' }, [
        h('button', {
          class: 'btn btn--primary',
          onclick: async () => {
            try {
              await api.patch(api.forInstance('/contacts/' + contact.id), {
                name: nomeInput.value.trim() || null,
              });
              await loadAll();
              renderList();
              renderSide();
            } catch (e) {
              alert('Erro ao salvar nome: ' + e.message);
            }
          },
        }, 'Salvar nome'),
        contact.name_source === 'manual'
          ? h('button', {
              class: 'btn',
              title: 'Remove seu nome manual e deixa o WhatsApp preencher de novo',
              onclick: async () => {
                try {
                  await api.patch(api.forInstance('/contacts/' + contact.id), { name: null });
                  await loadAll();
                  renderList();
                  renderSide();
                } catch (e) {
                  alert('Erro: ' + e.message);
                }
              },
            }, 'Devolver ao WhatsApp')
          : null,
      ]),
    );

    // Tags DESTE contato: aplicar/remover individualmente.
    const doContato = tagsByContact[contact.id] || [];
    const idsDoContato = new Set(doContato.map((t) => t.id));
    sideCard.appendChild(h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:4px' }, 'Tags do contato'));
    sideCard.appendChild(
      doContato.length
        ? h('div', { style: 'margin-bottom:8px' }, doContato.map((t) =>
            tagChip(t, async (ev) => {
              ev.preventDefault();
              try {
                await api.post(api.forInstance(`/tags/${t.id}/remove`), { contactIds: [contact.id] });
                await loadAll();
                renderList();
                renderSide();
              } catch (e) {
                alert('Erro: ' + e.message);
              }
            }),
          ))
        : h('div', { class: 'muted', style: 'margin-bottom:8px' }, 'Nenhuma tag neste contato.'),
    );

    const disponiveis = tags.filter((t) => !idsDoContato.has(t.id));
    if (disponiveis.length) {
      const sel = h('select', { class: 'select', style: 'flex:1' },
        disponiveis.map((t) => h('option', { value: t.id }, t.name)));
      sideCard.appendChild(
        h('div', { style: 'display:flex;gap:6px' }, [
          sel,
          h('button', {
            class: 'btn',
            onclick: async () => {
              try {
                await api.post(api.forInstance(`/tags/${sel.value}/apply`), { contactIds: [contact.id] });
                await loadAll();
                renderList();
                renderSide();
              } catch (e) {
                alert('Erro: ' + e.message);
              }
            },
          }, 'Aplicar'),
        ]),
      );
    }
  }

  (async () => {
    if (await loadAll()) {
      renderList();
      renderSide();
    }
  })();
  return root;
}

// ---------------------------------------------------------------- CRM (P6.4)
function crmScreen() {
  const listCard = h('div', { class: 'card' });
  const editCard = h('div', { class: 'card' });
  const root = h('div', {}, [
    pageHeader('CRM', 'Funil e estágios dos leads da instância.'),
    h('div', { class: 'dash-grid' }, [listCard, editCard]),
  ]);

  let selected = null; // contato selecionado

  async function loadList() {
    listCard.innerHTML = '';
    listCard.appendChild(h('h3', { class: 'card__title' }, 'Contatos'));
    const search = h('input', { class: 'select', placeholder: 'Buscar…', style: 'width:100%;margin-bottom:10px' });
    listCard.appendChild(search);
    const tableWrap = h('div', {});
    listCard.appendChild(tableWrap);

    const contacts = await api.get(api.forInstance('/contacts')).catch(() => []);
    const crmAll = await api.get(api.forInstance('/crm')).catch(() => []);
    const crmByContact = Object.fromEntries(crmAll.map((r) => [r.contact_id, r]));

    function draw(filter) {
      tableWrap.innerHTML = '';
      const term = (filter || '').toLowerCase();
      const rows = contacts
        .filter((c) => !term || (c.name || '').toLowerCase().includes(term) || c.phone.includes(term))
        .map((c) => {
          const crm = crmByContact[c.id];
          return h('tr', {
            style: 'cursor:pointer',
            onclick: () => { selected = c; renderEditor(); },
          }, [
            h('td', {}, [
              h('div', {}, c.name || c.phone),
              h('div', { class: 'muted', style: 'font-size:11px' }, c.phone),
            ]),
            h('td', {}, [h('span', { class: 'badge ' + (crm?.stage === 'cliente' ? 'badge--ok' : '') }, crm?.stage || 'sem CRM')]),
            h('td', {}, crm?.score != null ? String(crm.score) : '—'),
          ]);
        });
      if (!rows.length) {
        tableWrap.appendChild(h('div', { class: 'muted' }, 'Nenhum contato.'));
        return;
      }
      tableWrap.appendChild(
        h('table', { class: 'table' }, [
          h('thead', {}, [h('tr', {}, [h('th', {}, 'Contato'), h('th', {}, 'Estágio'), h('th', {}, 'Score')])]),
          h('tbody', {}, rows),
        ]),
      );
    }
    search.addEventListener('input', () => draw(search.value));
    draw('');
  }

  async function renderEditor() {
    editCard.innerHTML = '';
    if (!selected) {
      editCard.appendChild(h('div', { class: 'placeholder' }, 'Selecione um contato.'));
      return;
    }
    editCard.appendChild(h('h3', { class: 'card__title' }, selected.name || selected.phone));
    const crm = await api.get(api.forInstance('/crm/' + selected.id)).catch(() => null);

    const stage = h('input', { class: 'select', placeholder: 'Estágio (lead, qualificado, cliente…)', style: 'width:100%;margin-bottom:8px', value: crm?.stage || 'lead' });
    const score = h('input', { class: 'select', type: 'number', placeholder: 'Score', style: 'width:100%;margin-bottom:8px', value: crm?.score != null ? String(crm.score) : '0' });
    const notes = h('textarea', { class: 'select', rows: '4', placeholder: 'Notas…', style: 'width:100%;margin-bottom:8px' });
    notes.value = crm?.notes || '';
    const custom = h('textarea', { class: 'select', rows: '4', placeholder: '{ "campo": "valor" }', style: 'width:100%;margin-bottom:8px;font-family:monospace;font-size:12px' });
    custom.value = JSON.stringify(crm?.custom_fields || {}, null, 2);
    const msg = h('div', { class: 'muted', style: 'min-height:18px;margin-bottom:8px' });

    const field2 = (label, node) => h('div', { style: 'margin-bottom:4px' }, [
      h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:2px' }, label), node,
    ]);
    editCard.appendChild(field2('Estágio', stage));
    editCard.appendChild(field2('Score', score));
    editCard.appendChild(field2('Notas', notes));
    editCard.appendChild(field2('Campos customizados (JSON)', custom));
    editCard.appendChild(msg);
    editCard.appendChild(
      h('button', {
        class: 'btn btn--primary',
        onclick: async () => {
          msg.textContent = '';
          let customFields;
          try {
            customFields = JSON.parse(custom.value || '{}');
          } catch {
            msg.textContent = 'JSON inválido nos campos customizados.';
            return;
          }
          try {
            await api.raw('PUT', api.forInstance('/crm/' + selected.id), {
              stage: stage.value.trim() || null,
              score: Number(score.value) || 0,
              notes: notes.value || null,
              custom_fields: customFields,
            });
            msg.textContent = 'Salvo.';
            loadList();
          } catch (e) {
            msg.textContent = 'Erro: ' + e.message;
          }
        },
      }, 'Salvar CRM'),
    );
  }

  loadList();
  renderEditor();
  return root;
}

// -------------------------------------------------- Disparar Mensagem (P6.3)
function dispararScreen() {
  const formCard = h('div', { class: 'card' });
  const resultCard = h('div', { class: 'card' });
  const root = h('div', {}, [
    pageHeader('Disparar Mensagem', 'Envio avulso pela instância selecionada no topo.'),
    h('div', { class: 'dash-grid' }, [formCard, resultCard]),
  ]);

  let type = 'text';
  const history = [];

  function renderResult() {
    resultCard.innerHTML = '';
    resultCard.appendChild(h('h3', { class: 'card__title' }, 'Últimos envios (esta sessão)'));
    if (!history.length) {
      resultCard.appendChild(h('div', { class: 'muted' }, 'Nada enviado ainda.'));
      return;
    }
    resultCard.appendChild(
      h('table', { class: 'table' }, [
        h('thead', {}, [h('tr', {}, [h('th', {}, 'Para'), h('th', {}, 'Tipo'), h('th', {}, 'Resultado')])]),
        h('tbody', {}, history.map((hh) =>
          h('tr', {}, [
            h('td', {}, hh.to),
            h('td', {}, hh.type),
            h('td', {}, [h('span', { class: 'badge ' + (hh.ok ? 'badge--ok' : 'badge--off') }, hh.result)]),
          ]),
        )),
      ]),
    );
  }

  async function renderForm() {
    formCard.innerHTML = '';
    formCard.appendChild(h('h3', { class: 'card__title' }, 'Nova mensagem'));

    const to = h('input', { class: 'select', placeholder: 'Telefone (ex.: 5511999998888)', style: 'width:100%;margin-bottom:8px' });
    const typeSel = h('select', { class: 'select', style: 'width:100%;margin-bottom:8px' }, [
      h('option', { value: 'text' }, 'Texto'),
      h('option', { value: 'media' }, 'Mídia (URL)'),
      h('option', { value: 'template' }, 'Template (Meta)'),
    ]);
    typeSel.value = type;
    typeSel.addEventListener('change', () => { type = typeSel.value; renderForm(); });

    const fields = h('div', {});
    const msg = h('div', { class: 'muted', style: 'min-height:18px;margin:8px 0' });
    formCard.appendChild(to);
    formCard.appendChild(typeSel);
    formCard.appendChild(fields);
    formCard.appendChild(msg);

    let getBody = () => null;
    if (type === 'text') {
      const text = h('textarea', { class: 'select', rows: '4', placeholder: 'Mensagem…', style: 'width:100%' });
      fields.appendChild(text);
      getBody = () => ({ type: 'text', to: to.value.trim(), text: text.value });
    } else if (type === 'media') {
      const kind = h('select', { class: 'select', style: 'width:100%;margin-bottom:8px' },
        ['image', 'video', 'audio', 'document'].map((k) => h('option', { value: k }, k)));
      const url = h('input', { class: 'select', placeholder: 'URL pública do arquivo', style: 'width:100%;margin-bottom:8px' });
      const caption = h('input', { class: 'select', placeholder: 'Legenda (opcional)', style: 'width:100%' });
      fields.appendChild(kind);
      fields.appendChild(url);
      fields.appendChild(caption);
      getBody = () => ({
        type: 'media', to: to.value.trim(),
        media: { kind: kind.value, url: url.value.trim(), ...(caption.value ? { caption: caption.value } : {}) },
      });
    } else {
      // Template: escolhe entre os SINCRONIZADOS (idioma vem do registro da
      // Meta — nunca default). Variáveis {{1}}..{{n}} em campos livres.
      const templates = await api.get(api.forInstance('/templates')).catch(() => []);
      if (!templates.length) {
        fields.appendChild(h('div', { class: 'builder-warnings' },
          'Nenhum template sincronizado. Vá em Templates → Sincronizar da Meta.'));
        getBody = () => null;
      } else {
        const tplSel = h('select', { class: 'select', style: 'width:100%;margin-bottom:8px' },
          templates.map((t) => h('option', { value: t.name + '||' + t.language }, `${t.name} (${t.language})`)));
        const varsWrap = h('div', {});
        const varInputs = [];
        const addVar = () => {
          const input = h('input', { class: 'select', placeholder: '{{' + (varInputs.length + 1) + '}}', style: 'width:100%;margin-bottom:6px' });
          varInputs.push(input);
          varsWrap.appendChild(input);
        };
        addVar();
        fields.appendChild(tplSel);
        fields.appendChild(h('div', { class: 'muted', style: 'margin-bottom:4px' }, 'Variáveis do corpo:'));
        fields.appendChild(varsWrap);
        fields.appendChild(h('button', { class: 'btn', onclick: addVar }, '+ variável'));
        getBody = () => {
          const [name, language] = tplSel.value.split('||');
          const vars = {};
          varInputs.forEach((inp, i) => { if (inp.value.trim()) vars[String(i + 1)] = inp.value.trim(); });
          return { type: 'template', to: to.value.trim(), template: { name, language }, vars };
        };
      }
    }

    formCard.appendChild(
      h('button', {
        class: 'btn btn--primary', style: 'margin-top:8px',
        onclick: async () => {
          msg.textContent = '';
          const body = getBody();
          if (!body || !body.to) { msg.textContent = 'Preencha o telefone.'; return; }
          try {
            const res = await api.post(api.forInstance('/messages'), body);
            history.unshift({ to: body.to, type: body.type, ok: true, result: res.status + (res.wa_message_id ? '' : ' (fila)') });
            msg.textContent = 'Enviado.';
          } catch (e) {
            history.unshift({ to: body.to, type: body.type, ok: false, result: e.message });
            msg.textContent = 'Falha: ' + e.message;
          }
          renderResult();
        },
      }, 'Enviar'),
    );
  }

  renderForm();
  renderResult();
  return root;
}

// --------------------------------------------------------- Templates (P6.3)
function templatesScreen() {
  const card = h('div', { class: 'card' });
  const root = h('div', {}, [
    pageHeader('Templates', 'Templates aprovados na Meta (o idioma cadastrado lá é a fonte da verdade).'),
    card,
  ]);

  async function load() {
    card.innerHTML = '';
    const syncBtn = h('button', {
      class: 'btn btn--primary', style: 'margin-bottom:12px',
      onclick: async () => {
        syncBtn.disabled = true;
        syncBtn.textContent = 'Sincronizando…';
        try {
          const res = await api.post(api.forInstance('/templates/sync'));
          alert('Sincronizados: ' + res.synced + ' template(s).');
        } catch (e) {
          alert('Falha no sync: ' + e.message);
        }
        load();
      },
    }, 'Sincronizar da Meta');
    card.appendChild(syncBtn);

    const list = await api.get(api.forInstance('/templates')).catch(() => []);
    if (!list.length) {
      card.appendChild(h('div', { class: 'muted' }, 'Nenhum template sincronizado ainda.'));
      return;
    }
    card.appendChild(
      h('table', { class: 'table' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, 'Nome'), h('th', {}, 'Idioma'), h('th', {}, 'Categoria'), h('th', {}, 'Status'),
        ])]),
        h('tbody', {}, list.map((t) =>
          h('tr', {}, [
            h('td', {}, t.name),
            h('td', {}, [h('span', { class: 'badge' }, t.language)]),
            h('td', {}, t.category || '—'),
            h('td', {}, [h('span', { class: 'badge ' + (t.status === 'APPROVED' ? 'badge--ok' : 'badge--warn') }, t.status || '—')]),
          ]),
        )),
      ]),
    );
  }

  load();
  return root;
}

// ------------------------------------------------------ Instâncias (P6.2/V2)

// Status de conexão em português. `connecting` é o intervalo entre o QR ser
// aceito e a conexão voltar (o WhatsApp manda reiniciar depois do pareamento);
// sem rótulo próprio o painel dizia "disconnected" logo após um scan que deu
// certo — ver 03_MULTITENANCY_E_V2.md §3.4.
var STATUS_CONEXAO = {
  connected: { label: 'Conectado', badge: 'badge--ok' },
  connecting: { label: 'Conectando…', badge: 'badge--info' },
  pending: { label: 'Aguardando leitura', badge: 'badge--warn' },
  disconnected: { label: 'Desconectado', badge: 'badge--off' },
};
function statusConexao(status) {
  return STATUS_CONEXAO[status] || { label: status || '—', badge: 'badge--off' };
}

function instanciasScreen() {
  const listCard = h('div', { class: 'card' });
  const sideCard = h('div', { class: 'card' });
  const root = h('div', {}, [
    pageHeader('Instâncias', 'Números conectados (API Oficial ou Baileys).'),
    h('div', { class: 'dash-grid' }, [listCard, sideCard]),
  ]);

  let editing = null; // instância em edição (null = criar nova)
  let qrTimer = null;
  let listTimer = null;
  // Assinatura do que está DESENHADO. O polling só redesenha quando algo mudou
  // de fato — redesenhar a cada 3s trocaria o DOM debaixo do mouse do operador
  // (hover, foco, clique em andamento) sem nenhum ganho.
  let assinaturaDesenhada = null;
  registerCleanup(() => { if (qrTimer) clearInterval(qrTimer); });
  registerCleanup(() => { if (listTimer) clearInterval(listTimer); });

  /** O que, mudando, precisa reaparecer na lista. */
  function assinaturaDaLista(list) {
    return list
      .map((i) => [i.id, i.name, i.provider_type, i.connection_status, i.active,
        i.phone_number_id ?? '', i.secrets_unreadable ? 1 : 0].join(':'))
      .join('|');
  }

  async function loadList() {
    // Estado de carregando SÓ na primeira vez: nas recargas seguintes a lista
    // atual continua na tela até a nova chegar (sem piscar).
    if (assinaturaDesenhada === null && !listCard.children.length) {
      listCard.appendChild(h('h3', { class: 'card__title' }, 'Instâncias'));
      listCard.appendChild(h('div', { class: 'muted' }, 'Carregando…'));
    }
    let list = [];
    try {
      list = await api.listInstances();
    } catch (e) {
      listCard.innerHTML = '';
      listCard.appendChild(h('h3', { class: 'card__title' }, 'Instâncias'));
      listCard.appendChild(h('div', { class: 'muted' }, 'Erro: ' + e.message));
      assinaturaDesenhada = null; // força redesenho quando voltar a funcionar
      return;
    }
    desenharLista(list);
  }

  /**
   * Tick do polling: atualiza o status sem F5. Diferente do loadList manual em
   * dois pontos — não redesenha se nada mudou, e uma falha de rede NÃO apaga a
   * lista que está na tela (o operador continua vendo o último estado bom,
   * com o aviso do que aconteceu).
   */
  async function tickLista() {
    let list;
    try {
      list = await api.listInstances();
    } catch (e) {
      // Nunca silencioso: avisa SEM destruir o que já está desenhado.
      // eslint-disable-next-line no-console
      console.warn('[instâncias] atualização automática falhou:', e.message);
      mostrarAvisoDeAtualizacao('Atualização automática falhou (' + e.message + ').');
      return;
    }
    limparAvisoDeAtualizacao();
    desenharLista(list);
  }

  function mostrarAvisoDeAtualizacao(texto) {
    let el = listCard.querySelector('[data-aviso-polling]');
    if (!el) {
      el = h('div', {
        class: 'muted', style: 'font-size:12px;margin-bottom:8px;color:#92400e',
      });
      el.setAttribute('data-aviso-polling', '1');
      listCard.insertBefore(el, listCard.children[1] ?? null);
    }
    el.textContent = texto;
  }

  function limparAvisoDeAtualizacao() {
    const el = listCard.querySelector('[data-aviso-polling]');
    if (el) el.remove();
  }

  function desenharLista(list) {
    const assinatura = assinaturaDaLista(list);
    if (assinatura === assinaturaDesenhada) return; // nada mudou: não mexe no DOM
    assinaturaDesenhada = assinatura;
    listCard.innerHTML = '';
    listCard.appendChild(h('h3', { class: 'card__title' }, 'Instâncias'));
    if (!list.length) {
      listCard.appendChild(h('div', { class: 'muted' }, 'Nenhuma instância. Crie ao lado.'));
      return;
    }
    // Credenciais que não decifram com a chave atual: avisa em cima da lista,
    // com o caminho de saída. Antes disto o painel inteiro dava 500 e o
    // operador não tinha como nem chegar no formulário para recadastrar.
    const ilegiveis = list.filter((i) => i.secrets_unreadable);
    if (ilegiveis.length) {
      listCard.appendChild(
        h('div', { class: 'builder-warnings', style: 'margin-bottom:10px' },
          'Credenciais ilegíveis em: ' + ilegiveis.map((i) => i.name).join(', ') + '. ' +
          'Elas foram gravadas com outra SECRETS_ENCRYPTION_KEY. Restaure a chave usada ' +
          'para gravá-las OU clique em Editar e recadastre o token da Meta. ' +
          'Enquanto isso, envios por essas instâncias falham.'),
      );
    }
    listCard.appendChild(
      h('table', { class: 'table' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, 'Nome'), h('th', {}, 'Provider'), h('th', {}, 'Conexão'), h('th', {}, ''),
        ])]),
        h('tbody', {}, list.map((i) =>
          h('tr', {}, [
            h('td', {}, [
              h('div', {}, i.name),
              h('div', { class: 'muted', style: 'font-size:11px' }, i.phone_number_id || '—'),
              i.secrets_unreadable
                ? h('div', { style: 'font-size:11px;color:#991b1b' }, 'credenciais ilegíveis')
                : null,
            ]),
            h('td', {}, i.provider_type === 'baileys' ? 'Baileys' : 'Meta'),
            h('td', {}, [h('span', {
              class: 'badge ' + statusConexao(i.connection_status).badge,
            }, statusConexao(i.connection_status).label)]),
            h('td', { style: 'white-space:nowrap' }, [
              h('button', { class: 'btn', style: 'padding:3px 8px', onclick: () => { editing = i; renderForm(); } }, 'Editar'),
              ' ',
              i.provider_type === 'baileys'
                ? h('button', { class: 'btn', style: 'padding:3px 8px', onclick: () => showQr(i) }, 'QR')
                : null,
              ' ',
              h('button', {
                class: 'btn', style: 'padding:3px 8px;color:#991b1b',
                onclick: async () => {
                  if (!confirm('Remover a instância "' + i.name + '"? TODOS os dados dela (mensagens, contatos, fluxos) serão apagados.')) return;
                  await api.raw('DELETE', '/api/instances/' + i.id);
                  editing = null;
                  loadList();
                  renderForm();
                },
              }, '✕'),
            ]),
          ]),
        )),
      ]),
    );
  }

  function stopQr() {
    if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
  }

  // QR do Baileys: busca o SVG com o Bearer (img src não manda header) e
  // repete a cada 3s — o worker troca o QR periodicamente até o pareamento.
  async function showQr(inst) {
    stopQr();
    sideCard.innerHTML = '';
    sideCard.appendChild(h('h3', { class: 'card__title' }, 'Parear "' + inst.name + '"'));
    const status = h('div', { class: 'muted', style: 'margin-bottom:8px' }, 'Aguardando QR do worker…');
    const qrBox = h('div', { style: 'display:grid;place-items:center;min-height:280px' });
    sideCard.appendChild(status);
    sideCard.appendChild(qrBox);
    sideCard.appendChild(h('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
      'O worker precisa estar rodando (npm run worker). Abra o WhatsApp no celular → Aparelhos conectados → Conectar aparelho.'));
    sideCard.appendChild(h('button', { class: 'btn', style: 'margin-top:10px', onclick: () => { stopQr(); renderForm(); } }, 'Fechar'));

    async function poll() {
      try {
        const info = await api.get('/api/instances/' + inst.id + '/qr');
        status.textContent = statusConexao(info.connection_status).label;
        if (info.connection_status === 'connected') {
          qrBox.innerHTML = '';
          qrBox.appendChild(h('div', { class: 'placeholder__emoji' }, '✅'));
          stopQr();
          loadList();
          return;
        }
        if (info.connection_status === 'connecting') {
          // QR aceito: ele já foi apagado no banco e não serve mais. Mostra o
          // carregando em vez de deixar um QR morto na tela.
          status.textContent = 'QR aceito, conectando…';
          qrBox.innerHTML = '';
          qrBox.appendChild(h('div', { class: 'spinner' }));
          return;
        }
        if (info.qr) {
          const res = await fetch('/api/instances/' + inst.id + '/qr.svg', {
            headers: auth.token ? { Authorization: 'Bearer ' + auth.token } : {},
          });
          if (res.ok) qrBox.innerHTML = await res.text();
        }
      } catch (e) {
        status.textContent = 'Erro: ' + e.message;
      }
    }
    poll();
    qrTimer = setInterval(poll, 3000);
  }

  function renderForm() {
    stopQr();
    sideCard.innerHTML = '';
    sideCard.appendChild(h('h3', { class: 'card__title' }, editing ? 'Editar "' + editing.name + '"' : 'Nova instância'));

    const name = h('input', { class: 'select', placeholder: 'Nome', style: 'width:100%;margin-bottom:8px', value: editing?.name || '' });
    const provider = h('select', { class: 'select', style: 'width:100%;margin-bottom:8px' }, [
      h('option', { value: 'meta', ...(editing?.provider_type !== 'baileys' ? { selected: 'selected' } : {}) }, 'API Oficial (Meta)'),
      h('option', { value: 'baileys', ...(editing?.provider_type === 'baileys' ? { selected: 'selected' } : {}) }, 'Baileys (QR code)'),
    ]);
    const pnid = h('input', { class: 'select', placeholder: 'phone_number_id (Meta)', style: 'width:100%;margin-bottom:8px', value: editing?.phone_number_id || '' });
    const waba = h('input', { class: 'select', placeholder: 'waba_id (Meta)', style: 'width:100%;margin-bottom:8px', value: editing?.waba_id || '' });
    // Segredos: sempre vazios no form (a API só devolve mascarado). Preencher = substituir.
    const token = h('input', { class: 'select', placeholder: editing?.has_token ? 'Token (definido — preencha p/ trocar)' : 'Token (Meta)', style: 'width:100%;margin-bottom:8px' });
    const verify = h('input', { class: 'select', placeholder: editing?.has_verify_token ? 'Verify token (definido — preencha p/ trocar)' : 'Verify token (webhook)', style: 'width:100%;margin-bottom:8px' });
    const activeCb = h('input', { type: 'checkbox', ...((editing ? editing.active : true) ? { checked: 'checked' } : {}) });
    const msg = h('div', { class: 'muted', style: 'min-height:18px;margin:8px 0' });

    function syncProviderFields() {
      const isMeta = provider.value === 'meta';
      for (const el of [pnid, waba, token, verify]) el.style.display = isMeta ? '' : 'none';
    }
    provider.addEventListener('change', syncProviderFields);
    syncProviderFields();

    sideCard.appendChild(name);
    sideCard.appendChild(provider);
    sideCard.appendChild(pnid);
    sideCard.appendChild(waba);
    sideCard.appendChild(token);
    sideCard.appendChild(verify);
    sideCard.appendChild(h('label', { style: 'display:block;margin-bottom:4px' }, [activeCb, ' Ativa']));
    sideCard.appendChild(msg);
    sideCard.appendChild(
      h('button', {
        class: 'btn btn--primary',
        onclick: async () => {
          msg.textContent = '';
          const body = {
            name: name.value.trim(),
            provider_type: provider.value,
            phone_number_id: pnid.value.trim() || null,
            waba_id: waba.value.trim() || null,
            active: activeCb.checked,
          };
          if (token.value.trim()) body.token = token.value.trim();
          if (verify.value.trim()) body.verify_token = verify.value.trim();
          try {
            if (editing) await api.raw('PATCH', '/api/instances/' + editing.id, body);
            else await api.post('/api/instances', body);
            editing = null;
            msg.textContent = 'Salvo.';
            loadList();
            renderForm();
            state.instances = await api.listInstances(); // atualiza o seletor do topo
          } catch (e) {
            msg.textContent = 'Erro: ' + e.message;
          }
        },
      }, editing ? 'Salvar alterações' : 'Criar instância'),
    );
    if (editing) {
      sideCard.appendChild(h('button', {
        class: 'btn', style: 'margin-left:8px',
        onclick: () => { editing = null; renderForm(); },
      }, 'Cancelar'));
    }
  }

  loadList();
  renderForm();
  // Polling do status, 3s — MESMO intervalo do pareamento por QR (showQr), e
  // pelo mesmo motivo: é o ritmo em que o status muda quando alguém está
  // olhando (pending → connecting → connected). Sem isto, desativar ou apagar
  // uma instância só aparecia depois de um F5 na mão.
  //
  // Seguro contra sobrescrita de estado local: este tick só redesenha o
  // listCard. O formulário de edição e o QR vivem no sideCard e não são
  // tocados — não há edição inline na lista.
  listTimer = setInterval(() => { void tickLista(); }, 3000);
  return root;
}

// ------------------------------------------------------------ Login (P6.1/V2)
// A tela de login está montada? Enquanto estiver, NINGUÉM a remonta.
//
// Remontar parece inofensivo, mas destrói o formulário: o que o usuário já
// digitou some. Como renderLoginScreen() é chamada de todo 401 do api.raw,
// qualquer request em voo (ou polling que tenha escapado) transformava a tela
// num ciclo de "limpa tudo" — o bug relatado em produção.
let loginMontado = false;

/** Sai do modo login (chamado quando o shell do painel é montado). */
function resetLoginScreen() {
  loginMontado = false;
}

function renderLoginScreen() {
  // Idempotente: já está na tela → não mexe em nada.
  if (loginMontado) return;
  loginMontado = true;

  // Ir para o login é SAIR da tela anterior: mata pollings pendentes (Live
  // Chat, disparo, QR). Sem isto eles seguem batendo na API, tomam 401 e
  // reentram aqui em loop.
  runScreenCleanup();

  const app = document.getElementById('app');
  app.innerHTML = '';

  let mode = 'login'; // 'login' | 'register'
  // Registro público é FAIL-CLOSED no servidor: a tela só oferece "criar
  // organização" quando ele responde que está aberto (bootstrap ou
  // PUBLIC_SIGNUP). Sem isto, o botão levaria a um 403 sem explicação.
  let registroAberto = false;
  const wrap = h('div', {
    style: 'min-height:100vh;display:grid;place-items:center;background:var(--bg);padding:20px',
  });
  app.appendChild(wrap);

  // Nó próprio para o rodapé: a resposta do registration-status atualiza SÓ
  // ele. Redesenhar o cartão inteiro aqui apagaria o que já foi digitado —
  // a resposta chega alguns instantes depois de a tela abrir, bem no meio da
  // digitação.
  const rodape = h('div', {});

  function desenharRodape() {
    rodape.innerHTML = '';
    rodape.appendChild(
      registroAberto
        ? h('button', {
            class: 'btn', style: 'width:100%;margin-top:8px;border:none',
            onclick: () => { mode = mode === 'login' ? 'register' : 'login'; draw(); },
          }, mode === 'login' ? 'Não tem conta? Criar organização' : 'Já tem conta? Entrar')
        : h('div', { class: 'muted', style: 'font-size:12px;margin-top:10px;text-align:center' },
            'Novos usuários entram por convite do administrador da conta.'),
    );
  }

  fetch('/api/auth/registration-status')
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => {
      if (s) {
        registroAberto = !!s.open;
        desenharRodape(); // só o rodapé — os campos ficam intactos
      }
    })
    .catch(() => {
      /* offline: fica só o login, que é o caminho normal */
    });

  function draw() {
    wrap.innerHTML = '';
    const errEl = h('div', { class: 'muted', style: 'color:#991b1b;min-height:18px;margin-bottom:8px' });
    const email = h('input', { class: 'select', placeholder: 'E-mail', type: 'email', style: 'width:100%;margin-bottom:10px' });
    const pass = h('input', { class: 'select', placeholder: 'Senha (mín. 8)', type: 'password', style: 'width:100%;margin-bottom:10px' });
    const orgName = h('input', { class: 'select', placeholder: 'Nome da organização', style: 'width:100%;margin-bottom:10px' });

    async function submit() {
      errEl.textContent = '';
      try {
        const payload = mode === 'login'
          ? { email: email.value.trim(), password: pass.value }
          : { org_name: orgName.value.trim(), email: email.value.trim(), password: pass.value };
        const res = await api.raw('POST', '/api/auth/' + (mode === 'login' ? 'login' : 'register'), payload);
        auth.set(res.token, res.user);
        location.reload();
      } catch (e) {
        errEl.textContent = e.message;
      }
    }
    [email, pass, orgName].forEach((el) =>
      el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); }),
    );

    wrap.appendChild(
      h('div', { class: 'card', style: 'width:360px;max-width:100%' }, [
        h('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:16px' }, [
          h('div', { class: 'sidebar__logo' }, 'WA'),
          h('div', {}, [
            h('div', { style: 'font-weight:700' }, 'WA Manager'),
            h('div', { class: 'muted', style: 'font-size:12px' },
              mode === 'login' ? 'Entre na sua conta' : 'Crie sua organização'),
          ]),
        ]),
        mode === 'register' ? orgName : null,
        email,
        pass,
        errEl,
        h('button', { class: 'btn btn--primary', style: 'width:100%', onclick: submit },
          mode === 'login' ? 'Entrar' : 'Criar conta'),
        rodape,
      ]),
    );
    desenharRodape();
  }
  draw();
}

// ------------------------------------------------------ Convite (P6.1)
/**
 * Tela de aceite de convite (/convite/<token>). Rota PÚBLICA, como o login:
 * o convidado define a própria senha — o owner nunca a conhece.
 *
 * Quando o e-mail JÁ tem conta, o campo pede a SENHA ATUAL: é o que impede que
 * um convite vire "esqueci a senha" de conta alheia.
 */
function renderInviteScreen(token) {
  runScreenCleanup();
  const app = document.getElementById('app');
  app.innerHTML = '';
  const wrap = h('div', {
    style: 'min-height:100vh;display:grid;place-items:center;background:var(--bg);padding:20px',
  });
  app.appendChild(wrap);

  function card(children) {
    wrap.innerHTML = '';
    wrap.appendChild(h('div', { class: 'card', style: 'width:380px;max-width:100%' }, children));
  }

  card([h('div', { class: 'muted' }, 'Carregando convite…')]);

  fetch('/api/auth/invite/' + encodeURIComponent(token))
    .then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Convite inválido');
      return r.json();
    })
    .then((info) => {
      const errEl = h('div', { class: 'muted', style: 'color:#991b1b;min-height:18px;margin-bottom:8px' });
      const pass = h('input', {
        class: 'select', type: 'password', style: 'width:100%;margin-bottom:10px',
        placeholder: info.has_account ? 'Sua senha ATUAL' : 'Crie sua senha (mín. 8)',
      });
      const nome = h('input', { class: 'select', placeholder: 'Seu nome (opcional)', style: 'width:100%;margin-bottom:10px' });

      async function aceitar() {
        errEl.textContent = '';
        try {
          const body = { token, password: pass.value };
          if (!info.has_account && nome.value.trim()) body.name = nome.value.trim();
          const res = await api.raw('POST', '/api/auth/invite/accept', body);
          auth.set(res.token, res.user);
          location.href = '/';
        } catch (e) {
          errEl.textContent = e.message;
        }
      }
      pass.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') aceitar(); });

      card([
        h('div', { style: 'font-weight:700;margin-bottom:4px' }, 'Convite para ' + info.org_name),
        h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:14px' },
          info.email + ' — papel: ' + info.role),
        info.has_account
          ? h('div', { class: 'builder-warnings', style: 'margin-bottom:10px' },
              'Este e-mail já tem conta. Informe a senha atual dela para entrar também nesta conta.')
          : nome,
        pass,
        errEl,
        h('button', { class: 'btn btn--primary', style: 'width:100%', onclick: aceitar },
          info.has_account ? 'Entrar nesta conta' : 'Criar minha conta'),
      ]);
    })
    .catch((e) => {
      card([
        h('div', { style: 'font-weight:700;margin-bottom:8px' }, 'Convite indisponível'),
        h('div', { class: 'muted', style: 'margin-bottom:14px' }, e.message),
        h('button', { class: 'btn', style: 'width:100%', onclick: () => { location.href = '/'; } }, 'Ir para o login'),
      ]);
    });
}

// Estado do convite vem do servidor ('valid' = pendente e no prazo).
const ESTADO_CONVITE = {
  valid: 'pendente',
  used: 'aceito',
  revoked: 'cancelado',
  expired: 'expirado',
};

// --------------------------------------------------------- Equipe (P6.1)
/**
 * Tela de Equipe da CONTA ATIVA: membros (via org_members), convites e troca
 * da própria senha.
 *
 * A criação de usuário com senha escolhida pelo owner saiu de cena — entrada
 * de gente nova é só por convite, e quem define a senha é o convidado.
 */
function usuariosScreen() {
  const membrosCard = h('div', { class: 'card' });
  const convitesCard = h('div', { class: 'card' });
  const senhaCard = h('div', { class: 'card' });
  const ehOwner = auth.role() === 'owner';
  const root = ehOwner
    ? h('div', {}, [
        pageHeader('Equipe', 'Membros e convites desta conta (owner gerencia; agent só atende).'),
        h('div', { class: 'dash-grid' }, [membrosCard, convitesCard]),
        senhaCard,
      ])
    : h('div', {}, [pageHeader('Minha conta', 'Sua senha de acesso.'), senhaCard]);

  async function carregarMembros() {
    membrosCard.innerHTML = '';
    membrosCard.appendChild(h('h3', { class: 'card__title' }, 'Membros desta conta'));
    let membros = [];
    try {
      membros = await api.get('/api/users');
    } catch (e) {
      membrosCard.appendChild(h('div', { class: 'muted' }, 'Erro: ' + e.message));
      return;
    }
    if (!membros.length) {
      membrosCard.appendChild(h('div', { class: 'builder-warnings' },
        'Modo inicial: nenhum usuário cadastrado — o painel está aberto sem login. ' +
        'Crie a primeira conta pela tela de login para ativar a autenticação.'));
      return;
    }
    membrosCard.appendChild(
      h('table', { class: 'table' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, 'E-mail'), h('th', {}, 'Papel'), h('th', {}, 'Situação'), h('th', {}, ''),
        ])]),
        h('tbody', {}, membros.map((u) =>
          h('tr', {}, [
            h('td', {}, u.email),
            h('td', {}, [h('span', { class: 'badge ' + (u.role === 'owner' ? 'badge--ok' : '') }, u.role)]),
            h('td', {}, u.status === 'active' ? 'ativo' : 'desabilitado'),
            h('td', {}, [
              h('button', {
                class: 'btn',
                onclick: async () => {
                  const acao = u.status === 'active' ? 'disable' : 'enable';
                  try {
                    await api.post('/api/users/' + u.user_id + '/' + acao, {});
                    carregarMembros();
                  } catch (e) {
                    alert('Erro: ' + e.message);
                  }
                },
              }, u.status === 'active' ? 'Desabilitar' : 'Reabilitar'),
            ]),
          ]),
        )),
      ]),
    );
  }

  async function carregarConvites() {
    convitesCard.innerHTML = '';
    convitesCard.appendChild(h('h3', { class: 'card__title' }, 'Convites'));


    const email = h('input', { class: 'select', placeholder: 'E-mail do convidado', style: 'width:100%;margin-bottom:8px' });
    const papel = h('select', { class: 'select', style: 'width:100%;margin-bottom:8px' }, [
      h('option', { value: 'agent' }, 'agent — só Live Chat'),
      h('option', { value: 'owner' }, 'owner — administra tudo'),
    ]);
    const msg = h('div', { class: 'muted', style: 'min-height:18px;margin-bottom:8px;word-break:break-all' });

    // O link só aparece UMA vez (o banco guarda apenas o hash do token).
    function mostrarLink(res) {
      const url = location.origin + res.path;
      msg.innerHTML = '';
      msg.appendChild(h('div', {}, 'Link do convite (copie agora — ele não é exibido de novo):'));
      const campo = h('input', { class: 'select', style: 'width:100%;margin:6px 0' });
      campo.value = url;
      msg.appendChild(campo);
      msg.appendChild(h('button', {
        class: 'btn',
        onclick: () => {
          campo.select();
          if (navigator.clipboard) navigator.clipboard.writeText(url);
        },
      }, 'Copiar link'));
    }

    convitesCard.appendChild(email);
    convitesCard.appendChild(papel);
    convitesCard.appendChild(
      h('button', {
        class: 'btn btn--primary',
        onclick: async () => {
          msg.textContent = '';
          try {
            mostrarLink(await api.post('/api/invites', { email: email.value.trim(), role: papel.value }));
            email.value = '';
            carregarConvites();
          } catch (e) {
            msg.textContent = 'Erro: ' + e.message;
          }
        },
      }, 'Convidar'),
    );
    convitesCard.appendChild(msg);

    let convites = [];
    try {
      convites = await api.get('/api/invites');
    } catch (e) {
      convitesCard.appendChild(h('div', { class: 'muted' }, 'Erro: ' + e.message));
      return;
    }
    if (!convites.length) {
      convitesCard.appendChild(h('div', { class: 'muted' }, 'Nenhum convite ainda.'));
      return;
    }
    convitesCard.appendChild(
      h('table', { class: 'table' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, 'E-mail'), h('th', {}, 'Papel'), h('th', {}, 'Estado'), h('th', {}, ''),
        ])]),
        h('tbody', {}, convites.map((c) =>
          h('tr', {}, [
            h('td', {}, c.email),
            h('td', {}, c.role),
            h('td', {}, ESTADO_CONVITE[c.state] || c.state),
            h('td', {}, [
              c.state === 'valid'
                ? h('button', {
                    class: 'btn',
                    onclick: async () => {
                      try {
                        await api.del('/api/invites/' + c.id);
                        carregarConvites();
                      } catch (e) {
                        alert('Erro: ' + e.message);
                      }
                    },
                  }, 'Cancelar')
                : null,
              c.state !== 'accepted'
                ? h('button', {
                    class: 'btn',
                    style: 'margin-left:6px',
                    onclick: async () => {
                      try {
                        mostrarLink(await api.post('/api/invites/' + c.id + '/resend', {}));
                        carregarConvites();
                      } catch (e) {
                        alert('Erro: ' + e.message);
                      }
                    },
                  }, 'Reenviar')
                : null,
            ]),
          ]),
        )),
      ]),
    );
  }

  function renderSenha() {
    senhaCard.innerHTML = '';
    senhaCard.appendChild(h('h3', { class: 'card__title' }, 'Minha senha'));
    if (!auth.token) {
      senhaCard.appendChild(h('div', { class: 'muted' },
        'Modo inicial (sem usuários): não há senha para trocar.'));
      return;
    }
    const atual = h('input', { class: 'select', type: 'password', placeholder: 'Senha atual', style: 'width:100%;margin-bottom:8px' });
    const nova = h('input', { class: 'select', type: 'password', placeholder: 'Nova senha (mín. 8)', style: 'width:100%;margin-bottom:8px' });
    const msg = h('div', { class: 'muted', style: 'min-height:18px;margin-bottom:8px' });
    senhaCard.appendChild(atual);
    senhaCard.appendChild(nova);
    senhaCard.appendChild(msg);
    senhaCard.appendChild(
      h('button', {
        class: 'btn btn--primary',
        onclick: async () => {
          msg.textContent = '';
          try {
            const res = await api.post('/api/me/password', {
              current_password: atual.value,
              new_password: nova.value,
            });
            // Trocar a senha derruba TODAS as outras sessões; esta continua
            // valendo com o token novo.
            auth.set(res.token, auth.user);
            atual.value = '';
            nova.value = '';
            msg.textContent = 'Senha alterada. As outras sessões foram encerradas.';
          } catch (e) {
            msg.textContent = 'Erro: ' + e.message;
          }
        },
      }, 'Trocar senha'),
    );
  }

  if (ehOwner) {
    carregarMembros();
    carregarConvites();
  }
  renderSenha();
  return root;
}


// ---------------------------------------------------------------- render shell
function renderSidebar() {
  const brand = h('div', { class: 'sidebar__brand' }, [
    h('div', { class: 'sidebar__logo' }, 'WA'),
    h('div', {}, [
      h('div', { class: 'sidebar__title' }, 'WA Manager'),
      h('div', { class: 'sidebar__subtitle' }, 'API Oficial Meta'),
    ]),
  ]);

  const groups = visibleNav().map((group) =>
    h('div', {}, [
      h('div', { class: 'sidebar__section' }, group.section),
      ...group.items.map((item) => {
        const badgeVal = item.badgeKey ? BADGES[item.badgeKey] : 0;
        return h(
          'a',
          {
            class: 'nav-item' + (state.route === item.path ? ' active' : ''),
            href: item.path,
            onclick: (e) => {
              e.preventDefault();
              navigate(item.path);
            },
          },
          [
            h('span', { class: 'nav-item__icon' }, item.icon),
            h('span', {}, item.label),
            badgeVal ? h('span', { class: 'nav-item__badge' }, String(badgeVal)) : null,
          ],
        );
      }),
    ]),
  );

  return h('aside', { class: 'sidebar' }, [brand, ...groups]);
}

function renderTopbar() {
  const selector = h(
    'select',
    {
      class: 'select',
      onchange: (e) => {
        api.currentInstanceId = e.target.value;
        localStorage.setItem('wa.instanceId', e.target.value);
        renderCurrentScreen(); // troca de instância muda o contexto das telas
      },
    },
    state.instances.map((i) =>
      h('option', { value: i.id, ...(i.id === api.currentInstanceId ? { selected: 'selected' } : {}) }, i.name),
    ),
  );
  if (!state.instances.length) {
    selector.appendChild(h('option', { value: '' }, 'Nenhuma instância'));
  }

  // Seletor de CONTA (org ativa) — só aparece para quem participa de mais de
  // uma. Trocar reemite o JWT com a outra org e recarrega o painel inteiro,
  // porque tudo (instâncias, conversas, campanhas) muda de contexto.
  const orgs = auth.orgs();
  const orgSelector =
    orgs.length > 1
      ? h(
          'select',
          {
            class: 'select',
            style: 'margin-right:8px',
            onchange: async (e) => {
              try {
                const res = await api.post('/api/me/switch-org', { org_id: e.target.value });
                auth.set(res.token, auth.user);
                localStorage.removeItem('wa.instanceId'); // instância era da outra conta
                location.reload();
              } catch (err) {
                alert('Erro ao trocar de conta: ' + err.message);
              }
            },
          },
          orgs.map((o) =>
            h('option', {
              value: o.org_id,
              ...(o.org_id === auth.activeOrgId() ? { selected: 'selected' } : {}),
            }, o.org_name),
          ),
        )
      : null;

  return h('header', { class: 'topbar' }, [
    orgSelector,
    selector,
    h('div', { class: 'topbar__spacer' }),
    auth.user ? h('span', { class: 'muted', style: 'font-size:12px' }, auth.user.email) : null,
    h('span', { class: 'status' }, [h('span', { class: 'status__dot' }), 'Online']),
    h('button', {
      class: 'btn',
      onclick: () => {
        if (auth.token) {
          auth.clear();
          location.reload();
        } else {
          alert('Você está no modo inicial (sem usuários). Crie uma conta em Usuários para ativar o login.');
        }
      },
    }, 'Sair'),
  ]);
}

// Limpeza da tela atual (ex.: parar o polling do Live Chat ao sair dela).
//
// POR QUE ISTO É CRÍTICO: os pollings (Live Chat 4s, disparo de campanha, QR)
// fazem requests AUTENTICADAS. Se a tela some sem que o timer seja parado, ele
// continua batendo na API; quando o sistema tranca (primeiro owner criado,
// sessão revogada, token expirado), cada tick vira 401 → renderLoginScreen() →
// a tela de login é reconstruída POR CIMA do que o usuário está digitando, no
// ritmo do polling. Foi exatamente esse o bug do "login some a cada 2s".
//
// Lista, e não slot único: uma tela pode registrar mais de uma limpeza, e a
// versão anterior descartava silenciosamente todas menos a última.
let screenCleanups = [];
function registerCleanup(fn) {
  screenCleanups.push(fn);
}

/** Executa e esvazia TODAS as limpezas pendentes. Nunca lança. */
function runScreenCleanup() {
  const pendentes = screenCleanups;
  screenCleanups = [];
  for (const fn of pendentes) {
    try {
      fn();
    } catch (e) {
      console.error('[cleanup] falhou (seguindo):', e); // eslint-disable-line no-console
    }
  }
}
function refreshSidebar() {
  document.getElementById('sidebar-mount').replaceWith(withId(renderSidebar(), 'sidebar-mount'));
}

async function renderCurrentScreen() {
  runScreenCleanup();
  refreshSidebar();
  document.getElementById('topbar-mount').replaceWith(withId(renderTopbar(), 'topbar-mount'));
  const content = document.getElementById('content-mount');
  content.innerHTML = '';
  const render = screens[state.route] || screens['/dashboard'];
  const node = await render();
  content.appendChild(node);
}

function withId(node, id) {
  node.id = id;
  return node;
}

function navigate(path) {
  state.route = path;
  history.pushState({}, '', path);
  renderCurrentScreen();
}

// ------------------------------------------------------------------ bootstrap
async function boot() {
  // Convite é rota PÚBLICA: não passa por sessão nenhuma.
  const convite = /^\/convite\/(.+)$/.exec(location.pathname);
  if (convite) {
    renderInviteScreen(decodeURIComponent(convite[1]));
    return;
  }

  // Sessão primeiro: 401 aqui = sistema trancado sem token válido → o handler
  // do api.raw renderiza a tela de login e abortamos a montagem do shell.
  try {
    // GET /api/me traz a conta ativa, o papel NELA e as contas do usuário.
    auth.session = await api.get('/api/me');
    if (auth.session.user) auth.user = auth.session.user;
  } catch (e) {
    if (e.message === 'Não autenticado') return; // login já renderizado
    // Sessão existe mas não vale mais nesta conta (ex.: removido dela, papel
    // revogado). Montar o shell aqui daria um painel quebrado — volta ao login.
    auth.clear();
    renderLoginScreen();
    return;
  }
  try {
    state.instances = await api.listInstances();
  } catch (e) {
    if (e.message === 'Não autenticado') return;
    state.instances = [];
  }

  const app = document.getElementById('app');
  app.innerHTML = '';
  resetLoginScreen(); // saímos do login: a próxima falha de auth pode remontá-lo
  app.appendChild(
    h('div', { class: 'app-shell' }, [
      withId(h('div', {}, []), 'sidebar-mount'),
      h('div', { class: 'main' }, [
        withId(h('div', {}, []), 'topbar-mount'),
        withId(h('div', { class: 'content' }, []), 'content-mount'),
      ]),
    ]),
  );

  // Rota inicial a partir da URL (agent cai direto no Live Chat).
  const home = auth.role() === 'agent' ? '/livechat' : '/dashboard';
  state.route = location.pathname === '/' ? home : location.pathname;
  const saved = localStorage.getItem('wa.instanceId');
  const exists = state.instances.find((i) => i.id === saved);
  api.currentInstanceId = exists ? saved : state.instances[0]?.id || null;

  window.addEventListener('popstate', () => {
    state.route = location.pathname === '/' ? '/dashboard' : location.pathname;
    renderCurrentScreen();
  });

  await renderCurrentScreen();
}

boot();
