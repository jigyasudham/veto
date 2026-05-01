import { AgentPlan, WorkerAgentType } from '../types.js';

type FrontendType = 'component' | 'page' | 'form' | 'data-display' | 'general';

function detectFrontendType(task: string, context?: string): FrontendType {
  const combined = (task + ' ' + (context ?? '')).toLowerCase();
  if (combined.includes('form') || combined.includes('input') || combined.includes('submit') || combined.includes('validation')) return 'form';
  if (combined.includes('table') || combined.includes('list') || combined.includes('chart') || combined.includes('dashboard') || combined.includes('grid')) return 'data-display';
  if (combined.includes('page') || combined.includes('route') || combined.includes('view') || combined.includes('screen')) return 'page';
  if (combined.includes('component') || combined.includes('button') || combined.includes('modal') || combined.includes('dialog') || combined.includes('dropdown')) return 'component';
  return 'general';
}

const typeApproach: Record<FrontendType, string> = {
  component: 'Define the Props interface first. Implement the static presentational render before adding state. Extract sub-components when the render method exceeds 50 JSX lines. Test each state independently.',
  page: 'Design the page data requirements (what APIs to call), implement data fetching with loading/error/empty states, compose from smaller components. Handle navigation state and deep linking.',
  form: 'Use a form library (react-hook-form or Formik). Define the schema with Zod or Yup. Show inline validation errors. Handle submission loading state and server errors. Ensure keyboard-accessible.',
  'data-display': 'Fetch data with pagination or virtual scrolling for large datasets. Show skeleton loaders. Handle empty state with a clear call-to-action. Make columns resizable and sortable if applicable.',
  general: 'Design the component tree top-down. Define props interfaces before writing JSX. Add loading, error, and empty states to every data-dependent component.',
};

export function plan(task: string, context?: string): AgentPlan {
  const frontendType = detectFrontendType(task, context);

  return {
    agent: 'frontend' as WorkerAgentType,
    task,
    tier: 2,
    approach: typeApproach[frontendType],
    steps: [
      'Define the Props interface with JSDoc on every prop, including optional vs required',
      'Identify and define any local state the component manages',
      'Sketch the component tree — identify which parts should be extracted as sub-components',
      'Implement the static happy-path render with hardcoded sample data',
      'Replace sample data with props and verify TypeScript types',
      'Add loading state — use a skeleton loader, not a spinner for layout-heavy content',
      'Add error state — show a user-friendly message with a retry action',
      'Add empty state — show a meaningful prompt when there is no data',
      'Add useEffect for data fetching or subscriptions, with proper dependency array',
      'Implement event handlers and form submission logic',
      'Add ARIA roles, labels, and keyboard navigation for interactive elements',
      'Test with keyboard only — tab order must be logical',
      'Apply responsive CSS: mobile-first, then tablet (768px), then desktop (1280px) breakpoints',
      'Write render tests covering loading, error, empty, and data states',
      'Profile with React DevTools and memo/useMemo only where profiling shows a real regression',
    ],
    checklist: [
      '[ ] Props interface fully typed and exported',
      '[ ] Default props specified for optional props with sensible defaults',
      '[ ] Loading state uses skeleton loader matching the content layout',
      '[ ] Error state shows user-friendly message with retry button',
      '[ ] Empty state shows message and call-to-action',
      '[ ] No useEffect with stale closure (dependency array complete)',
      '[ ] No state for derived data — compute it from props/state on render',
      '[ ] Interactive elements are keyboard operable',
      '[ ] All images have alt text',
      '[ ] Form inputs have associated <label> elements',
      '[ ] Color is not the only means of conveying information',
      '[ ] Focus is managed correctly when modals open/close',
      '[ ] Component works at 320px mobile width',
      '[ ] Component works at 1440px desktop width',
      '[ ] No inline styles — use CSS modules or styled-components',
      '[ ] Render tests written for all significant states',
    ],
    pitfalls: [
      'Calling setState inside useEffect with the setState function in the dependency array — infinite re-render loop',
      'Forgetting the key prop on list items — React silently mismatches DOM elements during reconciliation',
      'Storing derived data (e.g., filtered list) in state instead of computing it on each render',
      'Using array index as key when the list can be reordered — causes incorrect component reuse',
      'Making components too generic too early — premature abstraction adds props nobody uses',
      'Not handling the loading state — a blank flash before data arrives breaks perceived performance',
      'useCallback / useMemo without profiling first — adds overhead for no measurable gain',
      'Forgetting to clean up event listeners, timers, and subscriptions in useEffect return function',
    ],
    patterns: [
      'Compound component pattern (parent shares state with slotted children)',
      'Controlled component pattern (props drive state, events propagate up)',
      'Render props pattern (for cross-cutting component logic)',
      'Custom hook extraction (move complex effect logic out of the component)',
      'Container / Presenter split (data fetching vs rendering separation)',
      'Skeleton loader pattern (avoid layout shift on load)',
    ],
    duration_estimate: frontendType === 'page' ? '4-8 hours' : '2-4 hours',
  };
}
