# Contribuir

Obrigado por contribuir para o Matchday Control.

## Antes de abrir um pull request

1. Explica o problema ou a alteração pretendida.
2. Mantém o comportamento agnóstico a clubes e instalações.
3. Atualiza a documentação quando mudares configuração, API ou operação.
4. Executa `bun run typecheck` e `bun test`.

## Convenções

- Usa TypeScript estrito e mantém as responsabilidades separadas por módulo.
- Não comitas `data/`, `scoreboard/`, executáveis, bases de dados ou credenciais.
- Não introduzas tokens, PINs, palavras-passe ou dados de uma instalação real.
- Para alterações do painel, testa em telemóvel e num ecrã largo quando possível.

## Pull requests

Descreve o que mudou, como foi validado e qualquer impacto de compatibilidade.
Alterações que afetam o formato dos cinco ficheiros de saída devem explicar
como os consumidores existentes podem migrar.
