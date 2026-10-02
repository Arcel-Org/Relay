'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Legacy setup page — redirects to v2 auth flow
 */
export default function SetupPage1() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/auth/landing');
  }, [router]);

  return null;
}
