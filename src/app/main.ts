import '@fontsource-variable/inter/wght.css';
// Arabic glyphs only (unicode-range), so it downloads only when Arabic text is shown.
import '@fontsource-variable/noto-sans-arabic/wght.css';
import '../ui/styles.css';
import { App } from './app';

const root = document.getElementById('app')!;
const app = new App(root);
void app.init();
