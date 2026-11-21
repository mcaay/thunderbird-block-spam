# Third-party licenses

Block Spam bundles the following third-party work. Versions are pinned in `package.json`.

## tldts 7.5.5 and tldts-core 7.5.5

Used at runtime to find registrable domains. Bundled unmodified into the add-on by the build.

- Source: https://github.com/remusao/tldts
- License: MIT

```
Copyright (c) 2017 Thomas Parisot, 2018 Rémi Berson

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Public Suffix List

tldts contains a compiled copy of the Public Suffix List.

- Source: https://publicsuffix.org
- License: Mozilla Public License 2.0, https://www.mozilla.org/en-US/MPL/2.0/

## free-email-domains 1.2.21

The bundled list of public mail provider domains in `src/data/publicDomains.ts` is seeded from the `domains.json` of this package, which is based on the HubSpot list of free email provider domains. The providers of appendix A of the design specification were added. The package itself is not a dependency.

- Source: https://github.com/Kikobeats/free-email-domains
- License: MIT

```
The MIT License (MIT)

Copyright © 2017 Kiko Beats <josefrancisco.verdu@gmail.com> (kikobeats.com)

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
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
