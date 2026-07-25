Idea Dump
Buidling on:
https://pc.0g.ai/

0g private computer is platorm where users can get private LLM inferance, making available plenty of models through a router endpoint. They also have 0g storage where you can store data in a decentralized and encrypted way.

At the core of this is that users who enjoy decentralized and private LLM inference, wheter for perosnal agents like [Openclaw](https://openclaw.ai/) or [Hermes](https://hermes-agent.org/) or coding agentes like [Codex](https://github.com/openai/codex), [Claude Code](https://claude.com/product/claude-code) (you) and [OpenCode](https://github.com/anomalyco/opencode), they would also like to have their memory stored and accessed in a decentralized and private way (in this case through 0g Storage)

The goal is to make this plug & play where things are setup in the following way:

- setup 0g storage enviroment automaticaly via a script, native functions, or wtv iway requires the miminum amount of steps
- npm install our stack
- attach the memory capture and fetching to the sdk that manages the agent runtime of the listed persoanl and codign agents
The plug and play experience should be the main value, so we need to pay attention to this. Couple of steps, and you have private memory
I don't want to build the memory stack, instead I want to fork [supermemory](https://github.com/supermemoryai/supermemory), research their examples for the persoanl and coding agents app's we're targeting and port directly only what we need so we can run this on 0g Storage

> **Update (2026-07-25):** pivoted from supermemory to **mem0 OSS** — research showed supermemory's memory engine is closed-source (only client SDKs/plugins are open), while mem0's full engine is Apache-2.0, runs in-process, and ships first-party plugins for most of our target agents. Plan of record: embed mem0 OSS + a journaling `VectorStore` wrapper for the 0G flush layer (D1/D7), per-host fork bases re-decided in `research/followup-fork-bases.md` (D18). Master map: `research/SYNTHESIS.md`.

There's also another detail that it's important, seems like 0g storage works in a way that the data needs to be fecth and then set to be updated. I want this plug and play memory system sdk to be synced (a good example for this is convex) and ephemeral, int he sense that we onlycare about fetching the memory to the private inference call during the agent runtime and then we discard it so it doesnt stay loclally. Also the output of the inference/completion requested should be an automatic mutation to the memory db state (I'm sure a lot of examples in supermemory do this part)

We should approach this into the following phases:
- Research:
  - Memory
    - supermemory
  - 0G:
    - 0g Private Computer
    - 0g storage
  - SDk
    - open ai sdk (what 0G uses for most models)
    - anthropic sdk (what 0G uses for claude)
  - Personal Agents
    - Openclaw
    - Hermes
  - Coding Agents
    - Codex
    - Claude Code
    - Open Code
Make sure to fill in key questions for each, check with me first, launch opus agents for each to answer solely by the docs or code it reviewed. Their work should be a md file in a /research folder. You should synthesize and map things out. If there is follow up or open questions still formulate the questions and launch the repsective agents.

Include this in the research instructions:

"In this research phase is very important to:
- if related to codebases, download the git codebase so you can freely analyse it
- read the docs and best practices
- We shouldn't create custom logic and features, things should be done with native fuctions or features of the sdks or libraries
- don't assume, verify everything and include references
- in the report created have this writing practices:
  - Breakdown things by:
    - High Level Overview good to sketch simple flows for each to visually explain
     - Key decisions and the reason why (MUST INCLUDE References of the best practices in the docs and codebase you researched)
     - be concise and structured, no fluff, tables over long paragraphs"