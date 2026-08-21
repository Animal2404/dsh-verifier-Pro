/* CDP smoke test: load each mario-*.html, start the game, run 300 update
   ticks, report runtime errors + basic state, save one screenshot. */
const fs = require('fs');

async function main() {
  let targets;
  for (let i = 0; i < 20; i++) {
    try {
      targets = await (await fetch('http://127.0.0.1:9222/json')).json();
      if (targets.some(t => t.type === 'page')) break;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value ?? r.result?.result?.description ?? JSON.stringify(r.result);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 540, deviceScaleFactor: 1, mobile: false });

  const files = ['mario-a.html', 'mario-b.html', 'mario-c.html', 'mario-final.html'];
  for (const f of files) {
    // collect console/exception errors
    await evalJs(`window.__errs = []; window.addEventListener('error', e => window.__errs.push(String(e.message))); 'ok'`);
    await send('Page.navigate', { url: 'file:///E:/DeepSeek/' + f });
    await new Promise(r => setTimeout(r, 1200));
    const result = await evalJs(`
      (function(){
        try {
          if (typeof startGame === 'function') startGame();
          else if (typeof window.start === 'function') window.start();
          let errs = [];
          for (let i = 0; i < 300; i++) {
            try {
              if (typeof update === 'function') update();
              else break;
            } catch (e) { errs.push(String(e.message) + ' @' + i); break; }
          }
          if (typeof draw === 'function') { try { draw(); } catch (e) { errs.push('draw: ' + e.message); } }
          const p = (typeof player !== 'undefined' && player) ? { x: Math.round(player.x), y: Math.round(player.y) } : null;
          return JSON.stringify({ state: (typeof state !== 'undefined') ? state : '?', player: p,
            ticksDone: errs.length === 0, errors: errs.slice(0, 3),
            globalErrs: (window.__errs || []).slice(0, 3) });
        } catch (e) { return JSON.stringify({ fatal: String(e.message) }); }
      })()
    `);
    console.log(`=== ${f}: ${result}`);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`E:/DeepSeek/dsh-verifier-Pro/tmp_articles/smoke-${f.replace('.html', '')}.png`, Buffer.from(r.result.data, 'base64'));
  }
  ws.close();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
