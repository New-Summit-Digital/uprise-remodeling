// supabase/functions/optimize-image/index.ts
//
// Compresses and converts uploaded images to WebP, resizing if larger than
// 1200px. Logs stats to image_optimization_logs.
//
// No Lovable dependencies — ported verbatim (ImageMagick WASM + Supabase only).

import { ImageMagick, initializeImageMagick, MagickFormat } from "npm:@imagemagick/magick-wasm@0.0.30";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const MAX_DIMENSION = 1200;

const wasmBytes = await Deno.readFile(
  new URL("magick.wasm", import.meta.resolve("npm:@imagemagick/magick-wasm@0.0.30")),
);
await initializeImageMagick(wasmBytes);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const bucket = (formData.get('bucket') as string) || 'parent-dog-images';
    const fileName = formData.get('fileName') as string;

    if (!file || !fileName) {
      return new Response(JSON.stringify({ error: 'Missing file or fileName' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const content = new Uint8Array(await file.arrayBuffer());
    const originalFormat = file.name.split('.').pop()?.toLowerCase() || 'unknown';

    let finalWidth = 0;
    let finalHeight = 0;
    const optimized = ImageMagick.read(content, (img): Uint8Array => {
      if (img.width > MAX_DIMENSION || img.height > MAX_DIMENSION) {
        const ratio = Math.min(MAX_DIMENSION / img.width, MAX_DIMENSION / img.height);
        img.resize(Math.round(img.width * ratio), Math.round(img.height * ratio));
      }

      finalWidth = img.width;
      finalHeight = img.height;
      img.quality = 80;

      return img.write(MagickFormat.Webp, (data) => new Uint8Array(data));
    });

    const webpFileName = fileName.replace(/\.[^.]+$/, '.webp');
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(webpFileName, optimized, {
        contentType: 'image/webp',
        upsert: false,
      });

    if (uploadError) {
      await supabaseAdmin.from('image_optimization_logs').insert({
        file_name: fileName, bucket, original_size: content.byteLength,
        optimized_size: 0, original_format: originalFormat, output_format: 'webp',
        width: finalWidth, height: finalHeight, success: false, error_message: uploadError.message,
      });
      return new Response(JSON.stringify({ error: uploadError.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(webpFileName);

    await supabaseAdmin.from('image_optimization_logs').insert({
      file_name: webpFileName, bucket, original_size: content.byteLength,
      optimized_size: optimized.byteLength, original_format: originalFormat, output_format: 'webp',
      width: finalWidth, height: finalHeight, success: true,
    });

    return new Response(JSON.stringify({
      publicUrl: urlData.publicUrl,
      originalSize: content.byteLength,
      optimizedSize: optimized.byteLength,
      format: 'webp',
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    try {
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      );
      await supabaseAdmin.from('image_optimization_logs').insert({
        file_name: 'unknown', bucket: 'unknown', original_size: 0,
        optimized_size: 0, success: false,
        error_message: error instanceof Error ? error.message : 'Internal error',
      });
    } catch { /* ignore */ }
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Internal error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
