# Changelog

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
