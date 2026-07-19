# Design Quality Policy

## Design lane contract

Before significant UI implementation, define:

- Target user.
- Screen purpose.
- Primary action.
- Information hierarchy.
- Existing components and tokens.
- Typography roles.
- Spacing and layout.
- Responsive behavior.
- RTL behavior when relevant.
- Loading, empty, error, and disabled states.
- Keyboard and focus behavior.
- Reduced-motion behavior.
- Accessibility expectations.
- One appropriate visual signature.
- Explicit visual non-goals.

## Tool pipeline

Use only relevant available tools:

```text
Figma -> frontend-design -> framework guidance -> component system -> Storybook -> Playwright Test -> axe-core -> Lighthouse -> visual regression
```

No item in the pipeline is a mandatory KRYLO Core dependency.

## Quality rules

- Follow the existing product design system.
- Avoid generic AI design defaults.
- Use representative content.
- Validate mobile, tablet, and desktop where relevant.
- Verify RTL and LTR independently when both exist.
- Inspect screenshots, not only DOM success.
- Keep animation purposeful and respect reduced motion.
- Treat copy as interface design.

## Visual evidence

Store temporary screenshots under plugin runtime data. Commit them only when the project already uses visual-regression fixtures or the task explicitly requires it.
