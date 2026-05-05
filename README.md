# vite-plugin-qingkuai

vite-plugin-qingkuai is a Vite plugin that transforms `.qk` component files into native JavaScript using the Qingkuai compiler. It enables fast and seamless development of web applications built with [Qingkuai](https://qingkuai.dev).

## Usage

```js
// vite.config.js
import { defineConfig } from "vite"
import qingkuai from "vite-plugin-qingkuai"

export default defineConfig({
    plugins: [qingkuai()]
})
```
