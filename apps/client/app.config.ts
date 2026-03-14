export default ({ config }: { config: Record<string, any> }) => {
  const baseUrl = process.env.EXPO_PUBLIC_WEB_BASE_PATH?.trim() ?? '';

  return {
    ...config,
    web: {
      ...config.web,
      bundler: 'metro',
      output: 'static',
    },
    experiments: {
      ...config.experiments,
      ...(baseUrl ? { baseUrl } : {}),
    },
  };
};
