# Third-Party Notices

## Sinon Source

The runtime, monitors, protocol policy, documentation, and socket fixtures originate in [ririnto/sinon](https://github.com/ririnto/sinon).
The standalone repository retains their additive import history and the original MIT license, copyright 2026 ririnto.

## Workgraph Repository Conventions

Repository configuration, issue forms, release validation, validation fixtures, thread lifecycle guidance, and the Markdown diagram rule adapt [ririnto/workgraph](https://github.com/ririnto/workgraph).
Workgraph declares the MIT license, copyright 2026 Workgraph contributors.
Its license notice follows.

```text
MIT License

Copyright (c) 2026 Workgraph contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## PStack Lifecycle Guidance

Lifecycle guidance adapts restart-safe operation principles from [PStack](https://github.com/cursor/plugins/tree/main/pstack).
PStack is distributed under the MIT License, copyright (c) 2026 Lauren Tan.
Its license notice follows.

```text
MIT License

Copyright (c) 2026 Lauren Tan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Runtime Dependencies

The npm launcher installs separately distributed runtime dependencies using the versions declared in `package.json`.
This repository does not vendor their source code.

| Dependency | Upstream | License |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x) | MIT |
| `ws` | [WebSocket library](https://github.com/websockets/ws) | MIT |
| `zod` | [Zod](https://github.com/colinhacks/zod) | MIT |

Development dependencies are recorded in `pnpm-lock.yaml` and retain their upstream licenses.
Official host and protocol references are listed in the runtime README metadata.

## Agent Skills

We read the complete [Agent Skills combined reference](https://agentskills.io/llms-full.txt) for portable frontmatter and progressive disclosure.
The thread-control skill follows its specification without redistributing the reference text.
The official `skills-ref` validator supplies local format evidence rather than model-behavior acceptance.

## Prompting Guidance Sources

We used original prose informed by these official prompting references.

- The [Claude overview](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview.md) explains success criteria and empirical evaluation.
- The [OpenAI model guide](https://developers.openai.com/api/docs/guides/latest-model.md) discusses instruction conflicts, output expectations, and change-appropriate verification.
- The [xAI prompting guide](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech/prompting-guide) covers objectives, factual sources, uncertainty, and matching tool definitions.
- The [Meta prompting guide](https://dev.meta.ai/llama/docs/how-to-guides/prompting) covers explicit context, output formatting, and evidence for claims.

Model-specific tuning and speech-specific advice are not repository-wide requirements.
