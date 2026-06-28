# Changelog

## 1.0.0 (2026-06-28)


### Features

* **agents:** Add coder agent definition ([917d1ce](https://github.com/dragomirweb/pi-brain-mode/commit/917d1cef43e891bab52737a6d7ede8dcedb41475))
* **agents:** Add reviewer agent definition ([26d2481](https://github.com/dragomirweb/pi-brain-mode/commit/26d248121b605e50d1ee74d025030741d426d2f7))
* **brain:** Add model configuration commands for worker and thinking models ([2eb4e98](https://github.com/dragomirweb/pi-brain-mode/commit/2eb4e98e30d773b8f4666683294d96d85b95ec46))
* **brain:** add reviewer toggle and model config (/brain reviewer) ([3c9de53](https://github.com/dragomirweb/pi-brain-mode/commit/3c9de535a134e6ccddafdc2aa2d61a0c60ddafe4))
* **bridge:** Add pi-subagents event bus bridge ([f756418](https://github.com/dragomirweb/pi-brain-mode/commit/f756418e4d355acad39554287dedc9088b65cd1d))
* **commands:** Add completions and model pickers ([6b376aa](https://github.com/dragomirweb/pi-brain-mode/commit/6b376aad04431f53acc042646487ca75dd1b368f))
* **commands:** Add interactive settings menu ([b6da3c3](https://github.com/dragomirweb/pi-brain-mode/commit/b6da3c377b9f8e849480d362e5d50754ed16a282))
* **delegate:** Add configurable worker timeout with partial progress ([29e69b6](https://github.com/dragomirweb/pi-brain-mode/commit/29e69b62f616a4139fe3fc75228272ff48f930df))
* **delegate:** run the project quality gate after each delegation ([03a8340](https://github.com/dragomirweb/pi-brain-mode/commit/03a8340c967d77c4e9301a2a8117dd46b860eec6))
* **package:** Add pi-subagents config ([ab0d4e0](https://github.com/dragomirweb/pi-brain-mode/commit/ab0d4e022ddafd8bb818866e23116915056d09b4))
* **reviewer:** add delegate_to_reviewer tool ([5ca86d8](https://github.com/dragomirweb/pi-brain-mode/commit/5ca86d8f9d8d8ffe20c68d4c8e81533d53ae1079))
* **state:** Extract delegate tool name as constant and include in orchestrator toolset ([3cf6b83](https://github.com/dragomirweb/pi-brain-mode/commit/3cf6b8391c2f3f0f11b3aed597958264b8119e7b))


### Bug Fixes

* **bash-classifier:** Add fprint0 to find destructive flags ([6350c3c](https://github.com/dragomirweb/pi-brain-mode/commit/6350c3c5af6c278af0a45a394588bca6837c4915))
* **bash-classifier:** do not treat quoted &gt; or =&gt; as a file redirect ([14a22a9](https://github.com/dragomirweb/pi-brain-mode/commit/14a22a90cf56a71ba8ec7f8fc046f5f6c485416e))
* **delegate:** tighten model-unavailable detection, add SIGKILL escalation and empty-output guard ([3642182](https://github.com/dragomirweb/pi-brain-mode/commit/3642182dde2604714844ab95473f8a673004292f))
* **prompts:** direct orchestrator to use repo-relative paths in delegations ([c282ea7](https://github.com/dragomirweb/pi-brain-mode/commit/c282ea75a9771f3f26d558c1e6a808dfe39d7f2a))
* **prompts:** forbid absolute paths and cd in the orchestrator's own shell ([e83ceed](https://github.com/dragomirweb/pi-brain-mode/commit/e83ceed697163375d762cee871368f6f8826cda0))
* **prompts:** tell the orchestrator it cannot execute code and how to verify ([dd284d1](https://github.com/dragomirweb/pi-brain-mode/commit/dd284d13e024e418fc153bc4ec8a41422b7ddc0a))
* **reviewer:** default the reviewer to the orchestrator model when unset ([59b078c](https://github.com/dragomirweb/pi-brain-mode/commit/59b078ce22b0f92980f1bba89574da9e10084f3b))

## Unreleased

- Tested against Pi v0.80.2.
