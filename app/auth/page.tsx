'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Legacy auth page — redirects to v2 auth landing
 */
export default function AuthPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/auth/landing');
  }, [router]);

  return null;
}
