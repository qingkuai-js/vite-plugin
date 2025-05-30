# vite-plugin-qingkuai

vite-plugin-qingkuai is a Vite plugin that transforms `.qk` component files into native JavaScript using the Qingkuai compiler. It enables fast and seamless development of web applications built with [QingKuai](https://qingkuai.dev)(a front-end framework).

[QingKuai Documentation](https://qingkuai.dev) | [VSCode extension For QingKuai Language Features](https://marketplace.visualstudio.com/items?itemName=qingkuai-tools.qingkuai-language-features) | [Issues]("https://github.com/qingkuai-js/vite-plugin/issues)

## Usage

```js
import { defineConfig } from "vite"
import qingkuai from "vite-plugin-qingkuai"

export default defineConfig({
    plugins: [qingkuai()]
})
```
