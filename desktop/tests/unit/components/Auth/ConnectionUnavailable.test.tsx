import { render, screen } from '../../../test-utils';

const getApiBaseMock = vi.hoisted(() => vi.fn(() => 'https://must-not-be-read.invalid'));
vi.mock('@/renderer/services/system/runtimeServerBase', () => ({
  getApiBase: getApiBaseMock,
  getWsBase: vi.fn(),
  apiUrl: vi.fn(),
}));

import ConnectionUnavailable from '@/renderer/components/Auth/ConnectionUnavailable';

describe('ConnectionUnavailable', () => {
  it('renders the Connection unavailable heading', () => {
    render(<ConnectionUnavailable />);

    expect(screen.getByRole('heading', { name: 'Connection unavailable' })).toBeInTheDocument();
  });

  it('never reads the API base', () => {
    render(<ConnectionUnavailable />);

    expect(getApiBaseMock).not.toHaveBeenCalled();
  });
});
