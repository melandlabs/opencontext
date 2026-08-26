# Third-party licenses

The `okf serve` viewer in this directory is **original to opencontext**
(`index.html`, `client.js`, `client-lib.js`, `styles.css`). No upstream
wiki viewer, no third-party brand. Only the browser libraries below are
loaded at runtime from `cdn.jsdelivr.net`; their license texts are
reproduced below.

## CDN-hosted browser libraries

Loaded by `index.html` via SRI-pinned `<script>` tags. **Not**
redistributed in this npm package.

| Library      | Version  | License     | Source                                       |
| ------------ | -------- | ----------- | -------------------------------------------- |
| force-graph  | 1.49.5   | MIT         | <https://github.com/vasturiano/force-graph>  |
| marked       | 12.0.2   | MIT         | <https://github.com/markedjs/marked>         |
| DOMPurify    | 3.4.12   | Apache-2.0  | <https://github.com/cure53/DOMPurify>        |
| mermaid      | 11.16.0  | MIT         | <https://github.com/mermaid-js/mermaid>     |
| Inter font   | (Google) | OFL-1.1     | <https://github.com/rsms/inter>              |

### force-graph — MIT

```
The MIT License (MIT)

Copyright (c) 2017 Vasco Asturiano

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
```

### marked — MIT

```
Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/)
Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
```

### DOMPurify — Apache-2.0

DOMPurify is dual-licensed under Apache-2.0 and MPL-2.0; we pin the
Apache-2.0 build. See <https://github.com/cure53/DOMPurify> for the
full text.

### mermaid — MIT

```
The MIT License (MIT)

Copyright (c) 2014 - 2024 Knut Sveidqvist

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED.
```

### Inter font — OFL-1.1

The Inter font is loaded from Google Fonts under the SIL Open Font
License. Full text: <https://github.com/rsms/inter/blob/master/LICENSE.txt>.