import { util as qingkuaiUtils } from "qingkuai/compiler"

export const globalStyle =
    "\n" +
    qingkuaiUtils
        .formatSourceCode(
            `
            /* Injected by vite-plugin-qingkuai */

            *[hidden] {
                display: none !important;
            }
        `
        )
        .replace(/^/gm, "    ") +
    "\n"

export const VIRTUAL_STYLE_ID_RE = /^virtual:\[\d+\].*?\.qk\.(css|s[ac]ss|less|stylus|postcss)\?\d{13}$/
