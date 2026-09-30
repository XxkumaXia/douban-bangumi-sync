import { send, sendStream } from './lib/msg.js';
import { confirmDialog, installErrorGuard } from './lib/dialog.js';
import { openInNewTab } from './lib/nav.js';

const $ = (id) => document.getElementById(id);
installErrorGuard();

// 一键同步：先在后台把「要写什么」算出来，确认后才真正写入
let quickPlan = null;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function dirLabel(dir) {
  if (dir === 'toBgm') return '→Bangumi';
  if (dir === 'toDouban') return '→豆瓣';
  if (dir === 'mixed') return '双向';
  return '待定';
}

async function refresh() {
  try {
    const [settings, snapshot, mapping] = await Promise.all([
      send({ type: 'SETTINGS_GET' }),
      send({ type: 'SNAPSHOT_GET' }),
      send({ type: 'MAPPING_GET' }),
    ]);

    const d = snapshot?.douban?.length ?? 0;
    const b = snapshot?.bangumi?.length ?? 0;
    const m = Object.keys(mapping || {}).length;
    $('nDouban').textContent = d || '—';
    $('nBgm').textContent = b || '—';
    $('nMap').textContent = m || '—';
    $('lastScan').textContent = snapshot?.scannedAt ? snapshot.scannedAt.slice(0, 16).replace('T', ' ') : '未扫描';

    const hasToken = !!settings.bgmAccessToken;
    if (!hasToken) {
      setStatus('warn', '尚未配置 Bangumi Token，点「设置」先填');
    } else if (!snapshot) {
      setStatus('ok', '已配置，可以开始扫描');
    } else {
      setStatus('ok', `已就绪（豆瓣 ${d} / Bangumi ${b}）`);
    }
  } catch (e) {
    setStatus('bad', `读取失败: ${e.message}`);
  }
}

function setStatus(kind, text) {
  const color = kind === 'ok' ? '#1a7f37' : kind === 'warn' ? '#b25e02' : '#cf222e';
  $('dot').style.background = color;
  $('statusLine').textContent = text;
}

// popup 里只能新开标签页：popup 自身会在失焦或被导航时关闭，
// 原地点跳转等于把自己关掉，所以这里必须用 openInNewTab
$('btnOpen').addEventListener('click', () => {
  openInNewTab('src/ui/sync.html');
});
$('btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('btnQuick').addEventListener('click', async () => {
  const host = $('quick');
  const btn = $('btnQuick');
  btn.disabled = true;
  quickPlan = null;
  host.innerHTML = '';
  $('msg').textContent = '扫描并匹配中…';
  try {
    const r = await sendStream({ type: 'QUICK_SYNC', payload: { confirm: false } }, (p) => {
      if (p.message) $('msg').textContent = p.message;
    });
    quickPlan = r;
    $('msg').textContent = `准备完成：将写入 ${r.todo} 条（→Bangumi ${r.toBgm} / →豆瓣 ${r.toDouban}）`;
    host.innerHTML =
      (r.preview || [])
        .slice(0, 5)
        .map(
          (p) =>
            `<div class="tiny-text">· ${escapeHtml(p.title)} <span class="muted">${dirLabel(p.dir)}</span></div>`
        )
        .join('') +
      (r.todo
        ? `<div class="row" style="margin-top:8px"><button class="primary" id="btnQuickRun" style="flex:1">确认写入 ${r.todo} 条</button></div>`
        : `<div class="tiny-text muted">两边已一致，没有需要写入的内容</div>`);
    $('btnQuickRun')?.addEventListener('click', runQuickWrite);
  } catch (e) {
    $('msg').textContent = `准备失败: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});

async function runQuickWrite() {
  if (!quickPlan) return;
  const go = await confirmDialog({
    title: '确认写入',
    message: `即将写入 ${quickPlan.todo} 条（→Bangumi ${quickPlan.toBgm} / →豆瓣 ${quickPlan.toDouban}）。`,
    okText: '确定写入',
    danger: true,
  });
  if (!go) return;
  const host = $('quick');
  const btn = $('btnQuickRun');
  if (btn) btn.disabled = true;
  $('msg').textContent = '写入中…';
  try {
    const r = await sendStream({ type: 'QUICK_SYNC', payload: { confirm: true } }, (p) => {
      if (p.done) $('msg').textContent = `写入 ${p.done}/${p.total}…`;
    });
    $('msg').textContent = `完成：成功 ${r.okCount}，失败 ${r.failCount}`;
    host.innerHTML = '';
    quickPlan = null;
    refresh();
  } catch (e) {
    $('msg').textContent = `写入失败: ${e.message}`;
  }
}

$('btnCheck').addEventListener('click', async () => {
  const msg = $('msg');
  msg.textContent = '检查中…';
  const lines = [];
  try {
    const bgmAuth = await send({ type: 'BGM_AUTH_CHECK' });
    lines.push(bgmAuth.ok ? `Bangumi: ${bgmAuth.username || '已授权'}` : `Bangumi: ${bgmAuth.error}`);
  } catch (e) {
    lines.push(`Bangumi: ${e.message}`);
  }
  try {
    const probe = await send({ type: 'PROBE_DOUBAN', payload: { site: 'movie' } });
    const bad = (probe.steps || []).filter((s) => !s.ok);
    lines.push(bad.length ? `豆瓣: ${bad.map((s) => `${s.name}(${s.detail})`).join('; ')}` : '豆瓣: 正常');
  } catch (e) {
    lines.push(`豆瓣: ${e.message}`);
  }
  msg.textContent = lines.join(' ｜ ');
});

refresh();
