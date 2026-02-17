# Desktop Client Tests

This directory contains tests for the Concord Desktop Client (Electron app).

## Structure

```
tests/
├── unit/         # Unit tests for components and utilities
├── integration/  # Integration tests for features
├── e2e/          # End-to-end tests with Electron
└── __mocks__/    # Mock modules and data
```

## Running Tests

### All Tests
```bash
npm test
```

### Unit Tests
```bash
npm run test:unit
```

### Integration Tests
```bash
npm run test:integration
```

### E2E Tests
```bash
npm run test:e2e
```

### Watch Mode
```bash
npm run test:watch
```

### Coverage
```bash
npm run test:coverage
```

## Writing Tests

### Unit Test Example (React Component)
```typescript
// tests/unit/Message.test.tsx
import { render, screen } from '@testing-library/react';
import Message from '../../src/renderer/components/Chat/Message';

describe('Message Component', () => {
  it('renders message content', () => {
    const message = {
      id: '1',
      content: 'Hello World',
      username: 'TestUser',
      created_at: new Date().toISOString()
    };

    render(<Message message={message} currentUserId="user1" />);

    expect(screen.getByText('Hello World')).toBeInTheDocument();
    expect(screen.getByText('TestUser')).toBeInTheDocument();
  });
});
```

### Integration Test Example
```typescript
// tests/integration/auth-flow.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import AuthFlow from '../../src/renderer/components/Auth/AuthFlow';

describe('Authentication Flow', () => {
  it('completes login flow', async () => {
    render(<AuthFlow />);

    // Select hosted login
    fireEvent.click(screen.getByText('Sign In to Existing Account'));

    // Fill in credentials
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'test@example.com' }
    });

    // Submit form
    fireEvent.click(screen.getByText('Sign In'));

    // Assert success
    await screen.findByText('Welcome back!');
  });
});
```

### E2E Test Example (Spectron/Playwright)
```typescript
// tests/e2e/app.spec.ts
import { test, expect } from '@playwright/test';

test('app launches successfully', async ({ page }) => {
  await page.waitForSelector('.app-container');
  expect(await page.title()).toBe('Concord');
});
```

## Test Utilities

### Common Test Setup
```typescript
// tests/utils/test-utils.tsx
import { render } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

export function renderWithRouter(ui: React.ReactElement) {
  return render(ui, { wrapper: BrowserRouter });
}
```

### Mock Data
Place reusable mock data in `__mocks__/`:
- `__mocks__/messages.ts` - Sample messages
- `__mocks__/users.ts` - Sample users
- `__mocks__/servers.ts` - Sample servers

## Testing Best Practices

1. **Test User Behavior, Not Implementation**
   - Focus on what users see and do
   - Avoid testing internal state

2. **Use Testing Library Queries**
   - Prefer `getByRole`, `getByLabelText`
   - Avoid `getByTestId` unless necessary

3. **Write Descriptive Test Names**
   - Use "it should..." format
   - Describe expected behavior

4. **Keep Tests Isolated**
   - Each test should be independent
   - Clean up after tests

5. **Mock External Dependencies**
   - Mock API calls
   - Mock Electron APIs
   - Use `__mocks__/` for module mocks

## CI/CD

Tests run automatically on:
- Pull requests
- Pushes to main/develop

See `.github/workflows/ci.yml` for configuration.

## Dependencies

Testing libraries included:
- `@testing-library/react` - React component testing
- `@testing-library/jest-dom` - Custom matchers
- `@playwright/test` - E2E testing (planned)
- `vitest` - Test runner

## Coverage Goals

Maintain minimum coverage:
- Overall: 80%
- Components: 85%
- Utilities: 90%
- Critical paths: 95%

## Troubleshooting

### Tests Not Running
```bash
# Clear test cache
npm test -- --clearCache

# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

### Electron Tests Failing
```bash
# Check Electron version compatibility
npm ls electron

# Rebuild native modules
npm run rebuild
```

## Resources

- [Testing Library Docs](https://testing-library.com/)
- [Vitest Docs](https://vitest.dev/)
- [Playwright Docs](https://playwright.dev/)
- [Electron Testing Guide](https://www.electronjs.org/docs/latest/tutorial/automated-testing)
