# Offline Kanban Font

JetBrains Mono Regular, unmodified upstream v2.304 webfont.

- Source: https://github.com/JetBrains/JetBrainsMono/tree/v2.304
- Font: https://raw.githubusercontent.com/JetBrains/JetBrainsMono/v2.304/fonts/webfonts/JetBrainsMono-Regular.woff2
- Copyright: 2020 The JetBrains Mono Project Authors.
- License: SIL Open Font License 1.1, included in `OFL.txt`.
- SHA-256: `a9cb1cd82332b23a47e3a1239d25d13c86d16c4220695e34b243effa999f45f2`

The server serves only this allowlisted file, before API authentication, under
`/fonts/JetBrainsMono-Regular.woff2`. The same-origin font requires no internet
connection or installed system fonts. Both source execution and compiled
`dist/kanban/server.js` resolve the packaged `src/kanban/static` directory.
Keep the font and license in the published package.
