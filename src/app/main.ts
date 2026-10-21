import { loadPlan } from '../data/loader';
import { InputState } from '../controls/input';
import { KeyboardMouse } from '../controls/keyboard-mouse';
import { detectTier, isMobileDevice, type Tier } from '../render/quality';
import { TourSession } from './session';
import { Tour } from './tour';

// Interim shell for milestones M3 and M4: full-window tour with desktop controls.
// The real UI (start screen, HUD, touch, PWA) replaces this in M5.

document.body.style.cssText = 'margin:0;background:#1b1d21;overflow:hidden;height:100dvh;';
const canvas = document.createElement('canvas');
canvas.style.cssText = 'display:block;width:100vw;height:100dvh;touch-action:none;';
document.getElementById('app')!.appendChild(canvas);

const params = new URLSearchParams(location.search);
const mobile = isMobileDevice();
const probe = new Tour(canvas, 'low', mobile);
const guess = detectTier(probe.renderer);
const tier = (['low', 'medium', 'high'] as Tier[]).includes(params.get('quality') as Tier) ? (params.get('quality') as Tier) : guess.tier;
probe.setTier(tier, mobile);
const tour = probe;

const resize = () => tour.resize(canvas.clientWidth, canvas.clientHeight);
new ResizeObserver(resize).observe(canvas);
resize();

const plan = await loadPlan();
await tour.load(plan, (f, label) => console.log(`[load] ${Math.round(f * 100)}% ${label}`));

const input = new InputState();
const session = new TourSession(tour, plan, input, {
  room: (n) => console.log('[room]', n),
  floor: (i) => console.log('[floor]', i),
  mode: (m) => console.log('[mode]', m),
});
const km = new KeyboardMouse(canvas, input, () => ({ sensitivity: 0.0022, invertY: false }), {
  toggleMode: () => session.toggleMode(),
  toggleHelp: () => {},
  toggleMinimap: () => {},
  toggleMenu: () => {},
  pointerLockChanged: () => {},
});
km.enabled = true;
canvas.addEventListener('click', () => km.requestLock());

tour.onUpdate = (dt) => session.update(dt);
tour.start();
void tour.upgradeHeroTextures().then((n) => n && console.log(`[textures] ${n} hero sets upgraded to 4K`));

Object.assign(window, {
  __tour: {
    tour,
    session,
    tier,
    guess,
    getState: () => session.getState(),
    setState: (s: Parameters<TourSession['setState']>[0]) => session.setState(s),
    stats: () => tour.stats(),
    /** Stops the loop and renders `frames` frames on demand (for screenshots in slow GL). */
    still(frames = 3) {
      tour.stop();
      for (let i = 0; i < frames; i++) {
        session.update(1 / 30);
        tour.renderOnce();
      }
    },
  },
});
document.body.dataset.ready = '1';
