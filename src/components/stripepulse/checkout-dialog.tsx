'use client';

import { useState } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { useUi } from '@/lib/stripepulse/store';

export function CheckoutDialog({ onPaid }: { onPaid: (runId: string) => void }) {
  const { checkoutOpen, checkoutMeta, closeCheckout } = useUi();
  const { toast } = useToast();
  const [paying, setPaying] = useState(false);

  if (!checkoutMeta) return null;
  const { runId, planName, amount } = checkoutMeta;

  const pay = async () => {
    setPaying(true);
    try {
      const res = await fetch('/api/demo/checkout/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      toast({ title: 'Payment succeeded', description: 'Webhooks are being delivered to the app…' });
      closeCheckout();
      onPaid(runId);
    } catch (e) {
      toast({ title: 'Payment failed', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setPaying(false);
    }
  };

  return (
    <Dialog open={checkoutOpen} onOpenChange={(o) => !o && closeCheckout()}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0" data-testid="checkout-dialog">
        <DialogTitle className="sr-only">Simulated Stripe Checkout</DialogTitle>
        <DialogDescription className="sr-only">
          Simulated Stripe hosted checkout for test mode. Paying confirms the scenario run.
        </DialogDescription>
        <div className="grid sm:grid-cols-[150px_1fr]">
          {/* Brand panel */}
          <div className="hidden flex-col justify-between bg-[#635bff] p-4 sm:flex">
            <div>
              <div className="flex items-center gap-1.5 text-white">
                <Lock className="h-3 w-3" />
                <span className="text-[10px] font-medium opacity-90">simulated checkout</span>
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-white/70">Subscribe to</div>
              <div className="text-lg font-bold text-white">StripePulse {planName}</div>
              <div className="mt-0.5 text-xs text-white/80">${(amount / 100).toFixed(2)} / month</div>
            </div>
          </div>

          {/* Form */}
          <div className="space-y-3 p-4">
            <div className="sm:hidden">
              <div className="text-sm font-bold">StripePulse {planName} — ${(amount / 100).toFixed(2)}/mo</div>
              <div className="text-[10px] text-muted-foreground">simulated test-mode checkout</div>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-medium text-muted-foreground" htmlFor="co-email">Email</label>
              <Input id="co-email" defaultValue="ava.demo@stripepulse.dev" className="h-8 text-xs" readOnly data-testid="checkout-email" />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-medium text-muted-foreground" htmlFor="co-card">Card information</label>
              <div className="overflow-hidden rounded-md border border-border">
                <Input
                  id="co-card"
                  defaultValue="4242 4242 4242 4242"
                  className="h-8 rounded-none border-0 border-b border-border text-xs font-mono"
                  readOnly
                  data-testid="checkout-card"
                />
                <div className="grid grid-cols-2">
                  <Input defaultValue="12 / 34" className="h-8 rounded-none border-0 border-b border-r border-border text-xs font-mono" readOnly />
                  <Input defaultValue="567" className="h-8 rounded-none border-0 border-b border-border text-xs font-mono" readOnly />
                </div>
                <Input defaultValue="United States" className="h-8 rounded-none border-0 text-xs" readOnly />
              </div>
            </div>
            <Button
              className="h-9 w-full bg-[#635bff] text-xs font-semibold hover:bg-[#544dff]"
              onClick={pay}
              disabled={paying}
              data-testid="checkout-pay"
            >
              {paying ? 'Processing…' : `Pay $${(amount / 100).toFixed(2)}`}
            </Button>
            <div className="flex items-center justify-center gap-1 text-[9px] text-muted-foreground">
              <ShieldCheck className="h-3 w-3" />
              Simulated test mode — no real charge. Powered by the built-in gateway.
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
