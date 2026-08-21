/* Drive headless Chrome via CDP to diagnose mario-b.html player visibility. */
const fs = require('fs');

const FILE = process.argv[2] || 'file:///E:/DeepSeek/mario-b.html';
const OUT = process.argv[3] || 'E:/DeepSeek/dsh-verifier-Pro/tmp_articles';

async function main() {
  // find page target
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
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
    console.log(`saved ${name}.png`);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 540, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: FILE });
  await new Promise(r => setTimeout(r, 1500));

  console.log('errors:', await evalJs(`window.__errs ? JSON.stringify(window.__errs) : 'not captured'`));
  console.log('state:', await evalJs(`state`));

  // Start the game deterministically: stop the rAF loop interference by
  // evaluating in page context. We drive update() manually.
  console.log(await evalJs(`startGame(); state`));

  // Case 1: during spawn invulnerability, on a SKIP frame
  const c1 = await evalJs(`
    (function(){
      loadLevel(0); frame = 0; state = 'playing';
      for (let i = 0; i < 10; i++) update();   // frame=10, invuln=110
      const skip = (p => p.invuln>0 && Math.floor(frame/4)%2===0)(player);
      draw();
      return JSON.stringify({frame, invuln: player.invuln, x: player.x, y: player.y, skipDraw: skip});
    })()
  `);
  console.log('case1 (spawn+10 ticks):', c1);
  await shot('mario-b-spawn-skip');

  // Case 2: same moment but forced into a DRAW phase of the blink
  const c2 = await evalJs(`
    (function(){
      frame += 4;  // floor(frame/4) flips parity -> draw phase
      draw();
      return JSON.stringify({frame, invuln: player.invuln});
    })()
  `);
  console.log('case2 (draw phase):', c2);
  await shot('mario-b-spawn-draw');

  // Case 3: after invulnerability fully expires
  const c3 = await evalJs(`
    (function(){
      for (let i = 0; i < 150; i++) update();  // invuln long gone
      draw();
      return JSON.stringify({frame, invuln: player.invuln, x: Math.round(player.x), y: Math.round(player.y), grounded: player.grounded});
    })()
  `);
  console.log('case3 (invuln expired):', c3);
  await shot('mario-b-after-invuln');

  // Case 4: die and respawn, then check visibility path
  const c4 = await evalJs(`
    (function(){
      killPlayer(false);
      for (let i = 0; i < 95; i++) update();   // dying anim completes -> respawn
      const info = {state, lives: lives, invuln: player.invuln, x: Math.round(player.x), y: Math.round(player.y)};
      draw();
      return JSON.stringify(info);
    })()
  `);
  console.log('case4 (after death+respawn):', c4);
  await shot('mario-b-respawn');

  ws.close();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
