import { AgentPlan, WorkerAgentType } from '../types.js';

type RefactorFocus = 'complexity' | 'duplication' | 'naming' | 'architecture' | 'types' | 'general';

function detectFocus(task: string, context?: string): RefactorFocus {
  const combined = (task + ' ' + (context ?? '')).toLowerCase();
  if (combined.includes('complex') || combined.includes('nesting') || combined.includes('long function') || combined.includes('spaghetti')) return 'complexity';
  if (combined.includes('duplicat') || combined.includes('copy') || combined.includes('repeat') || combined.includes('dry')) return 'duplication';
  if (combined.includes('naming') || combined.includes('rename') || combined.includes('readab')) return 'naming';
  if (combined.includes('architect') || combined.includes('layer') || combined.includes('module') || combined.includes('structure')) return 'architecture';
  if (combined.includes('type') || combined.includes('any') || combined.includes('typescript') || combined.includes('interface')) return 'types';
  return 'general';
}

const focusApproach: Record<RefactorFocus, string> = {
  complexity: 'Identify the most complex functions first using cyclomatic complexity metrics. Extract sub-functions, apply guard clauses, replace conditionals with polymorphism, reduce nesting step by step.',
  duplication: 'Find all duplicated logic using diff tools or manual inspection. Extract to a shared utility/hook/module. Parameterise differences. Verify all callers still work after consolidation.',
  naming: 'Rename systematically using IDE refactoring tools, not text-replace. Start with the most confusing names. Add JSDoc where a name alone is insufficient. Update all references atomically.',
  architecture: 'Diagram the current structure, identify coupling hotspots, define the target architecture, then migrate incrementally with an anti-corruption layer during transition.',
  types: 'Eliminate all implicit any types by enabling TypeScript strict mode. Define precise interfaces for all data shapes. Replace type assertions with proper narrowing. Add runtime validation at boundaries.',
  general: 'Apply the Boy Scout Rule: leave the code cleaner than you found it. Identify the highest-impact improvement (complexity, duplication, naming, or architecture) and address it first.',
};

export function plan(task: string, context?: string): AgentPlan {
  const focus = detectFocus(task, context);

  return {
    agent: 'refactor' as WorkerAgentType,
    task,
    tier: 2,
    approach: focusApproach[focus],
    steps: [
      'Run the full test suite and record the baseline — all tests must pass before and after',
      'Identify code smells: long functions, deep nesting, duplicated logic, primitive obsession, feature envy',
      'Prioritise by impact — fix the highest-complexity or most-duplicated code first',
      'Add missing tests for code that lacks coverage before refactoring it',
      'Apply extract function refactoring to any function longer than 30 lines',
      'Apply guard clauses (early returns) to reduce nesting depth',
      'Extract magic numbers and strings to named constants',
      'Rename variables and functions to be self-documenting — eliminate abbreviations',
      'Consolidate duplicated logic into shared utilities or base classes',
      'Remove dead code — if it is not tested and not called, delete it',
      'Apply TypeScript strict improvements — eliminate any, add precise types',
      'Run the linter and formatter after each logical change',
      'Run the full test suite again — compare with baseline, all tests must pass',
      'Review the diff — if a single commit is too large, split into atomic changes',
    ],
    checklist: [
      '[ ] All tests pass before starting refactoring',
      '[ ] All tests still pass after each refactoring step',
      '[ ] No function exceeds 30 lines of executable code after refactoring',
      '[ ] Nesting depth reduced to maximum 3 levels',
      '[ ] All magic numbers replaced with named constants',
      '[ ] No duplicated code blocks (copy-paste > 5 lines)',
      '[ ] All variables and functions have descriptive names',
      '[ ] No implicit any types remain',
      '[ ] Dead code removed (unused functions, imports, variables)',
      '[ ] Linter passes with zero warnings',
      '[ ] Code coverage not reduced by the refactoring',
      '[ ] Each commit is a single atomic refactoring step',
      '[ ] Public API is unchanged (or version-bumped if breaking)',
      '[ ] Complexity metrics improved — measure before and after',
    ],
    pitfalls: [
      'Refactoring without tests — you will not know if you broke something',
      'Big-bang refactoring in one commit — impossible to review, high merge conflict risk',
      'Renaming without IDE refactoring tools — misses call sites, creates runtime bugs',
      'Extracting a function that is only called once without a clear abstraction reason',
      'Changing behaviour while refactoring — refactoring must be semantics-preserving',
      'Removing code that looks unused but is called via dynamic reflection or eval',
      'Over-abstracting — a third function extracted for two call sites adds indirection without clarity',
    ],
    patterns: [
      'Extract Function (Fowler refactoring catalogue)',
      'Replace Conditional with Polymorphism',
      'Guard Clause (replace nested conditionals with early returns)',
      'Introduce Parameter Object (replace long parameter lists)',
      'Replace Magic Number with Symbolic Constant',
      'Move Function (reduce feature envy)',
      'Inline Variable (remove unnecessary variable aliases)',
      'Decompose Conditional',
      'Consolidate Duplicate Conditional Fragments',
    ],
    duration_estimate: focus === 'architecture' ? '1-3 days' : '2-6 hours',
  };
}
