# Changelog

## [0.3.0](https://github.com/encorp-io/llm-open-proxy/compare/@encorp.ai/llm-open-proxy-v0.2.2...@encorp.ai/llm-open-proxy-v0.3.0) (2026-10-10)


### Features

* add Microsoft Foundry provider (Azure OpenAI, Foundry Models, Claude) ([dd13123](https://github.com/encorp-io/llm-open-proxy/commit/dd13123f2f98bc835424b39675c1e165a8a5ebc2))
* add Microsoft Foundry provider (Azure OpenAI, Foundry Models, Claude) ([cab3289](https://github.com/encorp-io/llm-open-proxy/commit/cab328987db8a4ae01921fd648990aba13d7a7b0))


### Bug Fixes

* **anthropic:** per-family rules for current Claude models ([1ae399b](https://github.com/encorp-io/llm-open-proxy/commit/1ae399b9243c1619a7bfd0a8736a817bcc0f1bd3))
* **anthropic:** per-family rules for current Claude models ([34af065](https://github.com/encorp-io/llm-open-proxy/commit/34af06579da02a88ca430918bb6588ab57b19bb6))
* **foundry:** handle GPT-6 and project endpoints found in live testing ([80f6821](https://github.com/encorp-io/llm-open-proxy/commit/80f6821753db39e5e0b18467b5f75245b747080a))
* keep Azure error messages on Claude-on-Foundry; bump example dep ([6ab4028](https://github.com/encorp-io/llm-open-proxy/commit/6ab402858bc862ba970819315e3eb1c7306795db))
* **openai:** apply GPT-6 reasoning-model rules to the OpenAI config ([88689e0](https://github.com/encorp-io/llm-open-proxy/commit/88689e0c406c5f7db12dea96ff58227bfbba5924))
* per-family reasoning-model rules; forward mid-stream errors ([ea9e260](https://github.com/encorp-io/llm-open-proxy/commit/ea9e2609b79ba509fdbf0dc7fae1f345ee683511))

## [0.2.2](https://github.com/encorp-io/llm-open-proxy/compare/@encorp.ai/llm-open-proxy-v0.2.1...@encorp.ai/llm-open-proxy-v0.2.2) (2026-05-16)


### Documentation

* add community standards files (SECURITY, CONTRIBUTING, CoC, issue/PR templates, dependabot) ([6b04c9a](https://github.com/encorp-io/llm-open-proxy/commit/6b04c9a0529ea822412bf8c70ffded50862b01b7))


### Dependencies

* **deps-dev:** bump @redocly/cli from 1.34.14 to 2.30.6 ([95393d4](https://github.com/encorp-io/llm-open-proxy/commit/95393d4e1d25e0268e0240ec0865eae2ddf9e4a7))

## [0.2.1](https://github.com/encorp-io/llm-open-proxy/compare/@encorp.ai/llm-open-proxy-v0.2.0...@encorp.ai/llm-open-proxy-v0.2.1) (2026-05-16)


### Bug Fixes

* **ci:** accept release-please's prefixed tag format in release.yml ([f92e53a](https://github.com/encorp-io/llm-open-proxy/commit/f92e53a4da8b1a148255cf5a599f1d7b35d6ac5a))
* **ci:** use Node 24 in release workflow to avoid npm self-upgrade flake ([b31b8a1](https://github.com/encorp-io/llm-open-proxy/commit/b31b8a188dbdfa61856d28eba20866e31a114b85))

## [0.2.0](https://github.com/encorp-io/llm-open-proxy/compare/@encorp.ai/llm-open-proxy-v0.1.0...@encorp.ai/llm-open-proxy-v0.2.0) (2026-05-16)


### Features

* add .env support to examples + integration tests against real APIs ([194ceda](https://github.com/encorp-io/llm-open-proxy/commit/194ceda8178a31e4244f2119e8b1b8be1ce8c942))
* **types:** expose reasoning_content on canonical response message ([cef3ed0](https://github.com/encorp-io/llm-open-proxy/commit/cef3ed0b4a7117a980aef059cc9ab52ad2f65327))


### Bug Fixes

* **errors:** render upstream body in toString and util.inspect output ([bd620d3](https://github.com/encorp-io/llm-open-proxy/commit/bd620d311f94978a0b96b9f2ab2579ece5d198d3))
* **tests:** bump streaming budget to 256 tokens to accommodate thinking models ([4f43c43](https://github.com/encorp-io/llm-open-proxy/commit/4f43c432245c9d4b99a4c62644999e7e939b2869))
* **tests:** make integration suite robust to reasoning models ([004bdf2](https://github.com/encorp-io/llm-open-proxy/commit/004bdf2cde2a3282e5f1dcc25d585cbc6b850fcd))
