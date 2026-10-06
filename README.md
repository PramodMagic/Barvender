# Label Studio (MRP + Barcode)

Static tool: sirf `index.html`. Build ya database ki zarurat nahi.

## Vercel par deploy
**Tarika 1 (CLI)**
1. Node.js install karein.
2. Is folder me terminal kholein.
3. `npx vercel` chalayein, login karein, sab sawalon par Enter dabayein.
4. Production ke liye: `npx vercel --prod`

**Tarika 2 (GitHub)**
1. Is folder ko GitHub repo me push karein.
2. vercel.com par "Add New > Project" se repo import karein.
3. Framework Preset: Other. Build Command aur Output Directory khali rakhein. Deploy dabayein.

**Tarika 3 (bina deploy)**
`index.html` ko browser me double-click karke kholein (internet chahiye).

## Code badalna
- Nayi template: `index.html` me `TEMPLATES` object me entry add karein.
- Look/UI: `<style>` section ya tool ke andar "Custom template / CSS".
