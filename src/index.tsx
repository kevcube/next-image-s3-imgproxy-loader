import * as React from 'react';
import Image, { ImageLoaderProps, ImageProps } from 'next/image';

import { createHmac } from 'crypto';
import { ParsedUrlQuery } from 'node:querystring';
import { request as httpsRequest } from 'https';
import { ServerResponse, request as httpRequest } from 'http';

import ImgProxyParamBuilder from './param-builder';
import GravityType from './enums/gravity-type.enum';
import ResizeType from './enums/resize-type.enum';

const IMGPROXY_ENDPOINT = '/_next/imgproxy';
const SRC_REGEX = /^[^/.]+\/.+[^/]$/;

const FORWARDED_HEADERS = [
  'date',
  'expires',
  'content-type',
  'content-length',
  'cache-control',
  'content-disposition',
];

type ImageOptimizerOptions = {
  signature?: {
    key: string;
    salt: string;
  };
  authToken?: string;
  bucketWhitelist?: string[];
  forwardedHeaders?: string[];
};

const generateSignature = (key: string, salt: string, buff: string): string => {
  const hmac = createHmac('sha256', Buffer.from(key, 'hex'));
  hmac.update(Buffer.from(salt, 'hex'));
  hmac.update(buff);
  return hmac.digest().toString('base64url');
};

const imageOptimizer = (
  imgproxyBaseUrl: URL,
  query: ParsedUrlQuery,
  res: ServerResponse,
  options?: ImageOptimizerOptions,
) => {
  const { src, params } = query;
  const { authToken, bucketWhitelist, forwardedHeaders, signature } =
    options ?? {};

  // If the source is not set of fails the
  // regex check throw a 400
  if (!src || Array.isArray(src) || !SRC_REGEX.test(src)) {
    res.statusCode = 400;
    res.end();
    return;
  }

  // If the bucket whitelist is set throw a 400
  if (bucketWhitelist && !bucketWhitelist.includes(src.split('/')[0])) {
    res.statusCode = 400;
    res.end();
    return;
  }

  const paramString = params ? `${params}/` : '';
  const requestPath = `/${paramString}plain/s3://${src}`;

  const urlSignature = signature
    ? generateSignature(signature.key, signature.salt, requestPath)
    : '';

  const reqMethod = imgproxyBaseUrl.protocol.startsWith('https')
    ? httpsRequest
    : httpRequest;

  const req = reqMethod(
    {
      hostname: imgproxyBaseUrl.hostname,
      ...(imgproxyBaseUrl.port ? { port: imgproxyBaseUrl.port } : {}),
      path: `/${urlSignature}${requestPath}`,
      method: 'GET',
      headers: {
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
    },
    (r) => {
      (forwardedHeaders ?? FORWARDED_HEADERS).forEach((h) => {
        if (r.headers[h]) res.setHeader(h, r.headers[h] as string);
      });

      if (r.statusCode) res.statusCode = r.statusCode;

      r.pipe(res);
      r.on('end', () => res.end());
    },
  );

  req.on('error', (e) => {
    console.error(e);
    res.statusCode = 500;
    res.end();
    req.destroy();
  });

  req.end();
};

type ProxyImageProps = {
  file: string;
  proxyParams?: string;
  endpoint?: string;
};

const buildProxyImagePath = (
  file: string,
  options?: Omit<ProxyImageProps, 'file'>,
): string => {
  const { proxyParams, endpoint } = options ?? {};

  const urlParams = new URLSearchParams();

  urlParams.append('src', file);
  if (proxyParams) urlParams.append('params', proxyParams);

  return `${endpoint ?? IMGPROXY_ENDPOINT}?${urlParams.toString()}`;
};

const ProxyImage = ({
  file,
  proxyParams,
  endpoint,
  ...props
}: ProxyImageProps &
  Omit<ImageProps, 'src' | 'quality' | 'unoptimized' | 'loader'>) => {
  const imageLoader = ({ src, width }: ImageLoaderProps): string => {
    const urlParams = new URLSearchParams();
    urlParams.append('src', src);
    if (proxyParams) urlParams.append('params', proxyParams);

    // This doesn't actually do anything, it's just to suppress
    // this error https://nextjs.org/docs/messages/next-image-missing-loader-width
    if (width) urlParams.append('width', width.toString());

    // will return /_next/imgproxy?src=...&params=...&width=...
    return `${endpoint ?? IMGPROXY_ENDPOINT}?${urlParams.toString()}`;
  };

  return (
    <Image
      src={file}
      loader={imageLoader}
      {...(props.width == null && !props.layout ? { layout: 'fill' } : {})}
      {...props}
    />
  );
};

export default ProxyImage;
export {
  IMGPROXY_ENDPOINT,
  buildProxyImagePath,
  imageOptimizer,
  ImgProxyParamBuilder,
  GravityType,
  ResizeType,
};
