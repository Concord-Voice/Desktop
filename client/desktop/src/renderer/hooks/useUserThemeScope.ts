import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { resolveUserThemeScope } from '../utils/schemeColors';

interface ThemeScopeProps {
  'data-scheme': string;
  'data-theme': string;
  style?: CSSProperties;
}

/**
 * Returns props to spread on an identity component's root element,
 * scoping all CSS variable inheritance to the viewed user's color scheme
 * instead of the viewer's global theme.
 *
 * For preset schemes, sets data-scheme and data-theme attributes that
 * match existing CSS selectors in index.css.
 *
 * For custom schemes, additionally provides inline CSS variable overrides.
 */
export function useUserThemeScope(colorSchemeJson: string | null | undefined): {
  scopeProps: ThemeScopeProps;
} {
  const scopeProps = useMemo<ThemeScopeProps>(() => {
    const scope = resolveUserThemeScope(colorSchemeJson);
    const props: ThemeScopeProps = {
      'data-scheme': scope.scheme === 'custom' ? '' : scope.scheme,
      'data-theme': scope.themeMode,
    };
    if (scope.customStyles) {
      props.style = scope.customStyles;
    }
    return props;
  }, [colorSchemeJson]);

  return { scopeProps };
}
