import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('public/assets', { recursive: true });
await copyFile('web/index.html', 'public/index.html');
for (const file of ['app.js', 'styles.css']) await copyFile(`web/${file}`, `public/assets/${file}`);
