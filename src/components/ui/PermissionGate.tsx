'use client';

import type { ComponentType } from 'react';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState } from '@/components/ui/PageState';
import { useStackBack } from '@/hooks/useStackBack';
import { usePermission } from '@/hooks/usePermission';
import { ROUTE_NEEDS } from '@/lib/permissions';

/**
 * A PAGE SOMEBODY CANNOT USE, reached anyway.
 *
 * Every way in is hidden from a person without the permission (`canOpen`), so this is the second
 * layer: an old link, a URL, a page restored from before their role changed. Instead of a form whose
 * save the server will refuse, they get one header and one sentence. The server still refuses.
 */
export function gatePage(route: string, Page: ComponentType): ComponentType {
  if (!ROUTE_NEEDS[route]) return Page;
  function Gated() {
    const { canOpen } = usePermission();
    const goBack = useStackBack();
    if (canOpen(route)) return <Page />;
    return (
      <PageScaffold onBack={goBack} title="Not available">
        <PageState
          status={{
            state: 'empty',
            title: 'Not part of your job here',
            body: 'The owner decides who does this. Ask them if you need it.',
          }}
        >
          {() => null}
        </PageState>
      </PageScaffold>
    );
  }
  Gated.displayName = `Gated(${route})`;
  return Gated;
}
