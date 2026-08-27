# The accessibility tree is the only observation channel

Back-office banking apps are often table-based, nested in iframes, and free of test IDs. Some are not web apps at all. So we observe a Surface only through its accessibility structure, and the Surface Adapter has no method that returns markup or accepts a selector. A model cannot emit one, because there is nowhere to put it.

## Considered options

CSS and XPath selectors are unusable on this class of application, so they went early. Playwright's role and label locators were the harder call. They would have worked fine. We rejected them anyway, because leaving markup reachable means the claim that this design survives a surface with no clean DOM stays an assertion nobody can check.

## Consequences

An accessibility-tree or desktop Surface Adapter becomes a swap rather than a rewrite, since no Capability Artifact contains anything browser-shaped. The cost is real: a control the accessibility tree cannot express is genuinely unreachable. If that happens, we write it up as a finding about the approach rather than quietly putting selectors back.
