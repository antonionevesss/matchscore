# Segurança

## Reportar vulnerabilidades

Não publiques detalhes de uma vulnerabilidade num issue público. Contacta os
maintainers através do canal privado configurado no repositório e inclui:

- versão afetada;
- passos para reproduzir;
- impacto observado;
- uma correção ou mitigação, se existir.

## Modelo de operação

O Matchday Control foi desenhado para uma rede local confiável. Não deve ser
exposto diretamente à Internet sem uma camada adicional de rede e controlo de
acesso.

Cada instalação cria o seu próprio PIN e segredo de sessão. Protege a pasta
data/, sobretudo quando a integração OBS está configurada, porque contém a
palavra-passe do WebSocket.
