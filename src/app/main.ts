import { REVISION } from 'three';

const app = document.getElementById('app')!;
app.innerHTML = `
  <main style="font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100dvh; margin: 0; background: #1b1d21; color: #eef0f3;">
    <div style="text-align: center; padding: 1rem;">
      <h1 style="font-weight: 600; margin: 0 0 0.5rem;">CAD Tour</h1>
      <p style="margin: 0; opacity: 0.8;">Coming soon. Built on three r${REVISION}.</p>
    </div>
  </main>
`;
