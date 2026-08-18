import { createClient } from '@/utils/supabase/server';
import AddDeviceForm from './AddDeviceForm';
import DeviceLiveList from './DeviceLiveList';
import { Smartphone, ArrowLeft, ShieldCheck, RefreshCw } from 'lucide-react';
import Link from 'next/link';

export default async function DevicesPage() {
  const supabase = await createClient();

  // 1. Fetch registered physical devices
  const { data: devicesData } = await supabase
    .from('devices')
    .select('*')
    .order('created_at', { ascending: false });

  const registeredDevices = devicesData || [];

  return (
    <div className="space-y-8 animate-fade-in">
      
      {/* Top Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-baseline gap-2 pb-2 border-b border-meridian-border">
        <div>
          <h1 className="font-serif text-3xl font-medium tracking-tight text-meridian-text-1 flex items-center gap-2.5">
            <Smartphone className="w-8 h-8 text-meridian-gold" />
            Biometric Terminals
          </h1>
          <p className="text-xs font-mono uppercase tracking-widest text-meridian-text-3 mt-1">
            ADMS Hardware Integration & Terminal Status
          </p>
        </div>
        <Link 
          href="/dashboard" 
          className="inline-flex items-center gap-1.5 text-xs font-mono uppercase tracking-wider text-meridian-text-2 hover:text-meridian-gold transition"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Overview
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Hardware Status List (8 columns) */}
        <div className="lg:col-span-8 space-y-6">
          <div className="bg-meridian-panel border border-meridian-border rounded-2xl p-6">
            <div className="flex justify-between items-center pb-3 border-b border-meridian-border mb-6">
              <div>
                <h3 className="font-serif text-lg font-medium text-meridian-text-1">
                  Active Terminal Registry
                </h3>
                <p className="text-[11px] text-meridian-text-3 font-mono mt-0.5">
                  Synchronized biometric units connected via TCP/IP & ADMS
                </p>
              </div>
              <span className="text-[10px] font-mono tracking-wider text-meridian-text-2 bg-meridian-deep px-2.5 py-1 rounded flex items-center gap-1">
                <RefreshCw className="w-3 h-3 animate-spin text-meridian-gold" />
                POLLING LIVE (5s)
              </span>
            </div>

            <DeviceLiveList devices={registeredDevices as any} />

            <div className="mt-8 pt-4 border-t border-meridian-border/60 text-xs text-meridian-text-3 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-meridian-gold shrink-0" />
              <span>All biometric communication is encrypted using 256-bit AES protocols for children protection laws.</span>
            </div>
          </div>
        </div>

        {/* Register Device Form (4 columns) */}
        <div className="lg:col-span-4">
          <AddDeviceForm />
        </div>

      </div>

    </div>
  );
}
