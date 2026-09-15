import { configureGateway } from '../../src/core/ai/gateway.ts';
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'fake-key-not-real' } });
