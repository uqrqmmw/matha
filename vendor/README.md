# Vendored 第三方程式庫

全站零 CDN（離線可用＋杜絕供應鏈竄改），第三方程式庫以檔案形式 vendored 進 repo。
更新時：從官方發行版下載對應檔案覆蓋、更新本表版本與 SHA-256、跑 `npm test`。

| 套件 | 版本 | 檔案 | 上游 |
|---|---|---|---|
| supabase-js (UMD) | 2.110.2 | `supabase.js` | `@supabase/supabase-js` dist/umd/supabase.js |
| KaTeX | 0.16.11 | `katex/katex.min.js`、`katex/katex.min.css`、`katex/auto-render.min.js`、`katex/fonts/*.woff2`（僅 woff2，共 20 檔） | katex.org 發行包 |

授權文字見 `LICENSE-supabase-js.txt` 與 `katex/LICENSE-katex.txt`（皆為 MIT，vendoring 需保留授權聲明）。

## 現行檔案 SHA-256（更新後重算：`sha256sum vendor/supabase.js vendor/katex/*.min.* vendor/katex/auto-render.min.js`）

```
vendor/supabase.js:              21035ce4ffb6f1d6c5ba5344bbac8309bf394cdbba0b1371267a05a1d811fed8
vendor/katex/katex.min.js:       e6bfe5deebd4c7ccd272055bab63bd3ab2c73b907b6e6a22d352740a81381fd4
vendor/katex/katex.min.css:      717bc9ae7853b61f0f76455dddf0ecd4f527a783f42de2ac24684899c1c46258
vendor/katex/auto-render.min.js: 7b57d427ac6270677daf8d8380ded2cc73336f9149a167b8e1fe0d6ef66604ae
```
