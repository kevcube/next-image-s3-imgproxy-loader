import * as React from 'react';
import Image, { ImageLoaderProps, ImageProps } from 'next/image';

import { ParsedUrlQuery } from 'node:querystring';
import { request as httpsRequest } from 'https';
import { ServerResponse, request as httpRequest } from 'http';

import pb from '@bitpatty/imgproxy-url-builder';

import Logger, { LoggerOptions } from './logger';

type HandlerOptions = {
  signature?: {
    key: string;
    salt: string;
  };
  authToken?: string;
  bucketWhitelist?: string[];
  forwardedHeaders?: string[];
  logging?: LoggerOptions;
};

const IMGPROXY_ENDPOINT = '/_next/imgproxy';
const SRC_REGEX = /^[^/.]+\/.+[^/]$/;
const FORWARDED_HEADERS = [
  'date',
  'expires',
  'content-type',
  'content-length',
  'cache-control',
  'content-disposition',
  'content-dpr',
];

/**
 * Builds the final reuest path to retrieve an image from the imgproxy instance
 *
 * @param src      The source file
 * @param options  The imgproxy options
 * @returns        The imgproxy request path
 */
const buildRequestPath = (
  src: string,
  options?: {
    imgproxyParams?: string;
    signature?: {
      key: string;
      salt: string;
    };
  },
): string => {
  const { imgproxyParams, signature } = options ?? {};

  const paramBuilder = pb();
  if (imgproxyParams && imgproxyParams.includes(':')) {
    // @ts-ignore
    paramBuilder.modifiers.set('params', imgproxyParams);
  }

  return paramBuilder.build({
    path: `s3://${src}`,
    signature,
  });
};

/**
 * Handles an image request
 *
 * @param imgproxyBaseUrl  The URL to the imgproxy instance
 * @param query            The URL query generated by the {@link ImgProxyParamBuilder}
 * @param res              The response to which the resulting file should be piped to
 * @param options          Optional configuration options for the imgproxy connection
 */
const handle = (
  imgproxyBaseUrl: URL,
  query: ParsedUrlQuery,
  res: ServerResponse,
  options?: HandlerOptions,
): void => {
  const { src, params } = query;
  Logger.debug(options?.logging, 'Processing query', { src, params });

  const { authToken, bucketWhitelist, forwardedHeaders, signature } =
    options ?? {};

  // If the source is not set of fails the regex check throw a 400
  if (!src || Array.isArray(src) || !SRC_REGEX.test(src)) {
    Logger.error(options?.logging, 'Source failed validation check', src);
    res.statusCode = 400;
    res.end();
    return;
  }

  // If the bucket whitelist is set throw a 400 in case the bucket is
  // not included
  const bucketName = src.split('/')[0];
  if (bucketWhitelist && !bucketWhitelist.includes(bucketName)) {
    Logger.error(
      options?.logging,
      'Requested bucket is not whitelisted',
      bucketName,
    );
    res.statusCode = 400;
    res.end();
    return;
  }

  const requestPath = buildRequestPath(src, {
    imgproxyParams: params as string,
    signature,
  });

  Logger.debug(options?.logging, 'Built imgproxy URL', requestPath);

  const reqProto = imgproxyBaseUrl.protocol.startsWith('https')
    ? httpsRequest
    : httpRequest;

  const req = reqProto(
    {
      hostname: imgproxyBaseUrl.hostname,
      ...(imgproxyBaseUrl.port ? { port: imgproxyBaseUrl.port } : {}),
      path: requestPath,
      method: 'GET',
      headers: {
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
    },
    (r) => {
      (forwardedHeaders ?? FORWARDED_HEADERS).forEach((h) => {
        if (r.headers[h]) {
          Logger.debug(options?.logging, 'Forwarding header', {
            requestPath,
            header: h,
          });
          res.setHeader(h, r.headers[h] as string);
        }
      });

      if (r.statusCode) {
        Logger.debug(options?.logging, 'Received status code', {
          requestPath,
          statusCode: r.statusCode,
        });
        res.statusCode = r.statusCode;
      }

      r.pipe(res);
      r.on('end', () => {
        Logger.debug(options?.logging, 'Stream ended', { requestPath });
        res.end();
      });
    },
  );

  req.on('error', (e) => {
    Logger.error(options?.logging, 'Stream error', { requestPath, error: e });
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
export { IMGPROXY_ENDPOINT, buildProxyImagePath, handle };
