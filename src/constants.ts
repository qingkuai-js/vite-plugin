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
